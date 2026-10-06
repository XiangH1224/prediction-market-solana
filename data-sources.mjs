import {createHash} from 'node:crypto';
import {mappingFor,validateMapping,SERIES} from './source-mappings.mjs';
const HOSTS=new Set(['www.federalreserve.gov','api.bls.gov','api.stlouisfed.org','data.sec.gov','www.sec.gov','api.weather.gov','www.thesportsdb.com']);
const TTL={fed:300000,bls:3600000,fred:3600000,sec:600000,nws:60000,sports:600000};
export const cleanText=s=>String(s||'').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/<(script|style|nav|header|footer)\b[^>]*>[\s\S]*?<\/\1>/gi,' ').replace(/<[^>]*>/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&nbsp;/g,' ').replace(/&#(\d+);/g,(_,n)=>Number(n)<=0x10ffff?String.fromCodePoint(+n):'').replace(/\s+/g,' ').trim();
const number=value=>value!==null && value!==undefined && String(value).trim()!=='' && value!=='.' && Number.isFinite(Number(value)) ? Number(value) : null;
const same=(a,b)=>String(a).trim().toLowerCase()===String(b).trim().toLowerCase();
function item(provider,title,url,observations,extra={}) {
  return {id:`${provider.replace(/\W/g,'').slice(0,8)}-${createHash('sha256').update(url+JSON.stringify(observations)).digest('hex').slice(0,12)}`,provider,title,url,domain:new URL(url).hostname,observations,
    content:typeof observations==='string'?observations:JSON.stringify(observations),description:'',publishedAt:null,date:null,observationAt:null,retrievedAt:new Date().toISOString(),units:null,limitations:[],access:'Retrieved structured data or excerpt; limitations apply.',...extra};
}
export function createDataSources({env=process.env,fetcher=fetch,now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}) {
  const cache=new Map(),pending=new Map(),queues=new Map(),next=new Map(),cooldown=new Map(), daily=new Map();
  const secrets=[env.FRED_API_KEY,env.BLS_API_KEY,env.SPORTSDB_API_KEY,env.GNEWS_API_KEY].filter(Boolean);
  const redact=message=>secrets.reduce((text,key)=>text.split(key).join('[REDACTED]'),String(message)).replace(/(api_key|registrationkey)=([^&\s]+)/gi,'$1=[REDACTED]');
  const contact=/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.DATA_SOURCE_CONTACT_EMAIL||'');
  const ua=contact ? `Fieldnote research (${env.DATA_SOURCE_CONTACT_EMAIL})` : 'Fieldnote-Kalshi-Research/0.1 (local analysis backend)';
  function configured(key) {
    if(key==='fred'&&!env.FRED_API_KEY) return 'Set FRED_API_KEY in backend .env.';
    if(key==='sec'&&!contact) return 'Set DATA_SOURCE_CONTACT_EMAIL in backend .env.';
    if(key==='sports'&&env.SPORTSDB_API_KEY!=='123') return 'Optional free development connector: set SPORTSDB_API_KEY=123; other keys are disabled in free-only mode.';
    return '';
  }
  async function request(key,url,{json=true,body}={}) {
    const u=new URL(url);
    if(u.protocol!=='https:'||u.username||u.password||u.port||!HOSTS.has(u.hostname)) throw Error('Unsupported upstream address');
    const task=(queues.get(key)||Promise.resolve()).catch(()=>{}).then(async()=>{
      if((cooldown.get(key)||0)>now()) throw Error('Rate limited; wait before retrying.');
      const pause=Math.max(0,(next.get(key)||0)-now()); if(pause) await sleep(pause);
      if(key==='bls') {
        const day=new Date(now()).toISOString().slice(0,10),usage=daily.get(day)||0;
        if(usage>=(env.BLS_API_KEY?500:25))throw Error('BLS daily free request budget reached; retry tomorrow.');
        daily.clear();daily.set(day,usage+1);
      }
      next.set(key,now()+(key==='sports'?2100:key==='sec'?250:1100));
      let response;
      try {response=await fetcher(u.href,{method:body?'POST':'GET',body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(12000),headers:{Accept:json?'application/json, application/geo+json':'text/html, application/rss+xml, text/xml','User-Agent':ua,...(body?{'Content-Type':'application/json'}:{})}});}
      catch {throw Error('Upstream request failed or timed out.');}
      if(response.status===429 || response.status===503) {const retry=response.headers.get('retry-after');const delay=/^\d+$/.test(retry||'')?Number(retry)*1000:Math.max(60000,Date.parse(retry)-now()||0);cooldown.set(key,now()+Math.max(1000,delay));throw Error(`HTTP ${response.status}: rate limited or temporarily unavailable; retry later.`);}
      if(!response.ok) throw Error(`Upstream HTTP ${response.status}`);
      const reader=response.body.getReader();let text='',size=0;const decoder=new TextDecoder();
      while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>12000000){await reader.cancel();throw Error('Upstream response exceeds size limit');}text+=decoder.decode(value,{stream:true});}text+=decoder.decode();
      try {return json?JSON.parse(text):text;} catch {throw Error('Upstream returned invalid JSON');}
    });
    queues.set(key,task); return task;
  }
  const adapters={
    async fed(m) {
      const directory='https://www.federalreserve.gov/feeds/feeds.htm';
      const html=await request('fed',directory,{json:false});
      const expected=m.kind==='speeches'?'speeches.xml':'press_monetary.xml';
      const links=[...html.matchAll(/href=["']([^"']+)["']/gi)].map(x=>new URL(x[1],directory));
      const feed=links.find(u=>u.hostname==='www.federalreserve.gov' && u.pathname===`/feeds/${expected}`);
      if(!feed) throw Error('Requested official RSS feed was not linked by the Federal Reserve directory.');
      const xml=await request('fed',feed.href,{json:false});
      if(!/<rss[\s>]/i.test(xml)) throw Error('Invalid RSS response');
      const tag=(xml,name)=>cleanText(xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`,'i'))?.[1]);
      return [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].slice(0,3).flatMap(match=>{
        const title=tag(match[1],'title'),url=tag(match[1],'link'),date=tag(match[1],'pubDate'),summary=tag(match[1],'description');
        let u;try{u=new URL(url);}catch{return [];}
        if(u.hostname!=='www.federalreserve.gov'||u.protocol!=='https:'||!title)return [];
        if(m.start && (!Number.isFinite(Date.parse(date))||Date.parse(date)<Date.parse(m.start)))return [];
        return [item('Federal Reserve',title,url,summary,{publishedAt:date||null,date:date||null,access:'RSS summary only; full article not retrieved.',limitations:[m.kind==='speeches'?'An individual official’s speech is not a formal policy decision.':'Check effective date and whether this announcement is a formal policy decision.'],feedUrl:feed.href})];
      });
    },
    async bls(m) {
      const body={seriesid:m.seriesIds,startyear:String(m.startYear),endyear:String(m.endYear),...(env.BLS_API_KEY?{registrationkey:env.BLS_API_KEY}: {})};
      const data=await request('bls','https://api.bls.gov/publicAPI/v2/timeseries/data/',{body});
      if(data.status!=='REQUEST_SUCCEEDED') throw Error('BLS response status was not REQUEST_SUCCEEDED.');
      const series=data.Results?.series || data.Results?.[0]?.series;
      if(!Array.isArray(series)) throw Error('BLS series response is invalid');
      return series.filter(s=>m.seriesIds.includes(s.seriesID)).flatMap(s=>{
        const observations=(s.data||[]).filter(o=>+o.year>=m.startYear&&+o.year<=m.endYear).map(o=>({year:o.year,period:o.period,periodName:o.periodName,value:number(o.value),footnotes:o.footnotes||[]}));
        if(!observations.some(o=>o.value!==null))return [];
        const meta=SERIES[s.seriesID];return [item('BLS',`${meta.title} (${s.seriesID})`,`https://api.bls.gov/publicAPI/v2/timeseries/data/${s.seriesID}?startyear=${m.startYear}&endyear=${m.endYear}`,observations,{units:meta.units,seasonalAdjustment:meta.adjustment,observationAt:`${m.startYear}–${m.endYear}`,limitations:['Current BLS database values may include revisions; footnotes preserved.',...(m.firstReleaseRequired?['First-release figures required by this market are not established by this response; use an appropriate ALFRED vintage or original release.']:[])],originalProducer:'Bureau of Labor Statistics'})];
      });
    },
    async fred(m) {
      const params={series_id:m.seriesId,api_key:env.FRED_API_KEY,file_type:'json'};
      const metadata=await request('fred',`https://api.stlouisfed.org/fred/series?${new URLSearchParams(params)}`);
      const meta=metadata.seriess?.find(s=>s.id===m.seriesId);if(!meta)throw Error('FRED returned a different or missing series');
      const dates=m.firstRelease?{realtime_start:'1776-07-04',realtime_end:'9999-12-31',output_type:'4'}:m.vintage?{realtime_start:m.vintage,realtime_end:m.vintage}:{};
      const q={...params,observation_start:m.start,observation_end:m.end,...dates,limit:'1000'};
      const result=await request('fred',`https://api.stlouisfed.org/fred/series/observations?${new URLSearchParams(q)}`);
      if(!Array.isArray(result.observations)||result.error_code)throw Error('Invalid FRED observations response');
      const observations=result.observations.map(o=>({...o,value:number(o.value)}));if(!observations.some(o=>o.value!==null))return [];
      // Notes and release-source metadata identify the original producer, not FRED as producer.
      const release=await request('fred',`https://api.stlouisfed.org/fred/series/release?${new URLSearchParams(params)}`);
      const releaseId=release.releases?.[0]?.id;
      let producers=[];
      if(releaseId) {const result=await request('fred',`https://api.stlouisfed.org/fred/release/sources?${new URLSearchParams({release_id:String(releaseId),api_key:env.FRED_API_KEY,file_type:'json'})}`);producers=(result.sources||[]).map(s=>({name:s.name,url:s.link}));}
      const publicParams={...q};delete publicParams.api_key;
      return [item('FRED / ALFRED',meta.title,`https://api.stlouisfed.org/fred/series/observations?${new URLSearchParams(publicParams)}`,observations,{units:meta.units,frequency:meta.frequency,seasonalAdjustment:meta.seasonal_adjustment,observationAt:`${m.start}–${m.end}`,vintage:m.firstRelease?'Initial release only':m.vintage||'Current revised database',originalProducer:producers,metadataUpdatedAt:meta.last_updated,limitations:[meta.notes||'', 'Metadata update time is not the observation publication time.',...(Number(result.count)>observations.length?['Observation response truncated at 1000 entries.']:[])].filter(Boolean)})];
    },
    async sec(m) {
      const cik=String(m.cik).padStart(10,'0');
      const submissions=await request('sec',`https://data.sec.gov/submissions/CIK${cik}.json`);
      if(String(submissions.cik).padStart(10,'0')!==cik||!same(submissions.name,m.company))throw Error('SEC company identity does not match mapping.');
      const recent=submissions.filings?.recent; if(!recent?.accessionNumber)return [];
      const indexes=recent.accessionNumber.map((_,i)=>i).filter(i=>recent.form[i]===m.form&&recent.reportDate[i]===m.reportDate);
      if(indexes.length!==1)throw Error('Relevant filing is absent or ambiguous in recent submissions; no filing substituted.');
      const i=indexes[0],accession=recent.accessionNumber[i],doc=recent.primaryDocument[i];
      if(!/^\d{10}-\d{2}-\d{6}$/.test(accession)||!doc||/[\\/]/.test(doc))throw Error('Invalid SEC filing identifier');
      const url=`https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replaceAll('-','')}/${doc}`;
      const result=[];
      if(m.concepts?.length) {
        const facts=await request('sec',`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`);
        if(String(facts.cik).padStart(10,'0')!==cik)throw Error('SEC facts company mismatch');
        for(const concept of m.concepts) {const fact=facts.facts?.['us-gaap']?.[concept]; if(!fact)continue;
          const observations=Object.entries(fact.units||{}).flatMap(([units,values])=>values.filter(v=>v.accn===accession&&v.end===m.reportDate).map(v=>({...v,units})));
          if(observations.length) result.push(item('SEC EDGAR',`${submissions.name}: ${fact.label}`,url,observations,{publishedAt:recent.filingDate[i],date:recent.filingDate[i],observationAt:m.reportDate,units:[...new Set(observations.map(o=>o.units))].join(', '),limitations:['Historical reported XBRL facts; not management forecasts. Check duration and fiscal period.']}));
        }
      }
      if(m.filingText!==false) {const raw=await request('sec',url,{json:false});const text=cleanText(raw);if(/access denied|request rate threshold/i.test(text.slice(0,300)))throw Error('SEC filing text unavailable');result.push(item('SEC EDGAR',`${submissions.name} ${m.form} for ${m.reportDate}`,url,text.slice(0,18000),{publishedAt:recent.filingDate[i],date:recent.filingDate[i],observationAt:m.reportDate,access:'Filing text excerpt; truncated at 18,000 characters.',limitations:['Distinguish historical results, forward-looking statements and risks; omitted sections have not been analyzed.']}));}
      if(result.length>1) {
        const filing=result.find(a=>typeof a.observations==='string');
        const facts=result.filter(a=>Array.isArray(a.observations));
        return [item('SEC EDGAR',`${submissions.name} ${m.form} for ${m.reportDate}`,url,{facts:facts.map(a=>({title:a.title,units:a.units,observations:a.observations})),filingExcerpt:filing?.content || null},{publishedAt:recent.filingDate[i],date:recent.filingDate[i],observationAt:m.reportDate,units:facts.map(a=>a.units).join(', '),limitations:result.flatMap(a=>a.limitations),access:'Retrieved XBRL facts and filing excerpt; omitted sections are not analyzed.'})];
      }
      return result;
    },
    async nws(m) {
      const point=await request('nws',`https://api.weather.gov/points/${m.latitude},${m.longitude}`);const p=point.properties;
      if(!p || p.timeZone!==m.timeZone)throw Error('NWS point/time-zone mapping mismatch');
      const checked=url=>{const u=new URL(url);if(u.origin!=='https://api.weather.gov')throw Error('Invalid NWS discovery link');return u.href;};
      if(m.kind==='forecast') {
        const url=checked(p.forecastHourly||p.forecast);const data=await request('nws',url);
        const observations=(data.properties?.periods||[]).filter(o=>Date.parse(o.startTime)<Date.parse(m.end)&&Date.parse(o.endTime)>Date.parse(m.start));
        if(!observations.length)return [];
        if(observations.some(o=>o.temperatureUnit!==m.units))throw Error('Forecast units do not match mapping; no implicit conversion applied.');
        return [item('National Weather Service',`${m.location}: forecast`,url,observations,{publishedAt:data.properties.generatedAt,date:data.properties.generatedAt,observationAt:`${m.start}–${m.end}`,units:m.units,location:m.location,timeZone:m.timeZone,limitations:['Forecast, not an observation or final settlement value.'],stale:now()-Date.parse(data.properties.generatedAt)>86400000})];
      }
      const stations=await request('nws',checked(p.observationStations));
      const station=stations.features?.find(s=>s.properties?.stationIdentifier===m.station);if(!station)throw Error('Requested station is not in the discovered station list; no nearest-station substitution.');
      const stationUrl=checked(station.id||`https://api.weather.gov/stations/${m.station}`);
      const url=`${stationUrl}/observations?${new URLSearchParams({start:m.start,end:m.end,limit:'500'})}`;
      const data=await request('nws',url);const observations=(data.features||[]).map(f=>f.properties).filter(o=>Date.parse(o.timestamp)>=Date.parse(m.start)&&Date.parse(o.timestamp)<Date.parse(m.end));
      if(!observations.length)return [];
      if(observations.some(o=>o.station && !o.station.endsWith(`/stations/${m.station}`)))throw Error('Observation station identity mismatch');
      if(observations.some(o=>o[m.measurement]?.unitCode!==m.units))throw Error('Observation units mismatch; no implicit conversion applied.');
      return [item('National Weather Service',`${m.location}: ${m.station} observations`,url,observations,{observationAt:`${m.start}–${m.end}`,units:m.units,measurement:m.measurement,timeZone:m.timeZone,location:m.location,station:m.station,limitations:['Station observations may be incomplete or provisional; not certified daily extrema or final settlement data.',...(data.pagination?.next?['Additional observations exist; response is incomplete.']:[])],stale:now()-Math.max(...observations.map(o=>Date.parse(o.timestamp)))>10800000})];
    },
    async sports(m) {
      const data=await request('sports',`https://www.thesportsdb.com/api/v1/json/123/lookupevent.php?id=${m.eventId}`);
      const e=data.events?.find(e=>String(e.idEvent)===String(m.eventId));if(!e)return [];
      if(!same(e.strSport,m.sport)||!same(e.strLeague,m.league)||!same(e.strHomeTeam,m.home)||!same(e.strAwayTeam,m.away)||e.dateEvent!==m.date)throw Error('Sports event identity mismatch; unrelated events were excluded.');
      return [item('TheSportsDB',e.strEvent,`https://www.thesportsdb.com/event/${m.eventId}`,{idEvent:e.idEvent,sport:e.strSport,league:e.strLeague,home:e.strHomeTeam,away:e.strAwayTeam,date:e.dateEvent,time:e.strTime,status:e.strStatus,homeScore:number(e.intHomeScore),awayScore:number(e.intAwayScore)},{observationAt:e.strTimestamp||e.dateEvent,limitations:['Free development event/background data; freshness not guaranteed. Not a live-score, injury or detailed tennis-statistics feed.','Missing scores are null, never zero.']})];
    }
  };
  function status(event,mappings={}) {
    return mappingFor(event,mappings).map(p=>{const missing=configured(p.key),invalid=p.relevant?validateMapping(p.key,p.mapping):'';return {...p,status:!p.relevant?'No relevant data':missing?'Not configured':invalid?'No relevant data':'Ready',reason:!p.relevant?'Not relevant to this market.':missing||invalid,retrievedAt:null};});
  }
  async function fetchSource(event,key,mappings={}) {
    const p=status(event,mappings).find(s=>s.key===key);if(!p)throw Error('Unknown provider');
    const publicStatus=({mapping,...rest})=>rest;
    if(p.status!=='Ready')return {articles:[],status:publicStatus(p)};
    const token=JSON.stringify([key,p.mapping]);const existing=cache.get(token);
    if(existing && existing.expiresAt>now())return {articles:structuredClone(existing.articles),status:{...publicStatus(p),status:existing.articles.length?'Cached':'No relevant data',reason:existing.articles.length?'':'Cached empty result; no matching observations.',retrievedAt:existing.retrievedAt}};
    if(pending.has(token))return pending.get(token);
    const job=(async()=>{try {const articles=await adapters[key](p.mapping);const retrievedAt=new Date(now()).toISOString();
      articles.forEach(a=>{a.retrievedAt=retrievedAt;a.limitations=[...(a.limitations||[]),...(a.stale?['Data is stale relative to retrieval time; verify freshness against the market period.']:[])];});
      if(cache.size>=200)cache.delete(cache.keys().next().value);
      cache.set(token,{articles:structuredClone(articles),retrievedAt,expiresAt:now()+TTL[key]});
      return {articles,status:{...publicStatus(p),status:articles.length?'Retrieved':'No relevant data',retrievedAt,reason:articles.length?'':'Successful request returned no matching observations.'}};
    }catch(error){return {articles:[],status:{...publicStatus(p),status:'Error',reason:redact(error.message),retrievedAt:existing?.retrievedAt||null}};}})();
    pending.set(token,job);try{return await job;}finally{pending.delete(token);}
  }
  return {status:(event,mappings)=>status(event,mappings).map(({mapping,...p})=>p),fetchSource};
}
