// Labeled synthetic fixtures. These tests do not claim live provider verification.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createDataSources} from '../data-sources.mjs';
import {validateMapping,mappingFor} from '../source-mappings.mjs';
const event={marketTicker:'FIXTURE'};
const bls={seriesIds:['CUUR0000SA0'],startYear:2025,endYear:2025};
const fred={seriesId:'CPIAUCNS',start:'2025-01-01',end:'2025-12-31',firstRelease:true};
const sec={cik:'320193',company:'Apple Inc.',form:'10-K',reportDate:'2024-09-28',concepts:['Revenues'],filingText:true};
const nws={latitude:40.7789,longitude:-73.9692,location:'Central Park',timeZone:'America/New_York',station:'KNYC',units:'wmoUnit:degC',measurement:'temperature',kind:'observation',start:'2025-01-01T00:00:00Z',end:'2025-01-02T00:00:00Z'};
const sports={eventId:'12345',sport:'Tennis',league:'Fixture Open',home:'Player A',away:'Player B',date:'2025-01-01'};
const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
const make=(fetcher,env={},options={})=>createDataSources({fetcher,env,sleep:async()=>{},...options});
const data={status:'REQUEST_SUCCEEDED',Results:{series:[{seriesID:'CUUR0000SA0',data:[{year:'2025',period:'M01',periodName:'January',value:'317.2',footnotes:[{code:'P',text:'Preliminary'}]},{year:'2025',period:'M02',value:'-',footnotes:[]}]}]}};

test('unconfigured sources are disabled independently; optional BLS registration stays usable',()=>{
 const engine=make(()=>{throw Error('Unexpected request')});const rows=engine.status(event,{FIXTURE:{bls,fred,sec,nws,sports,fed:{kind:'monetary'}}});
 assert.equal(rows.find(r=>r.key==='bls').status,'Ready');
 assert.equal(rows.find(r=>r.key==='nws').status,'Ready');
 for(const key of ['fred','sec','sports'])assert.equal(rows.find(r=>r.key===key).status,'Not configured');
 assert.equal(rows.find(r=>r.key==='fed').status,'Ready');
});
test('ambiguous questions and invalid mappings never trigger requests',async()=>{
 const engine=make(()=>{throw Error('Unexpected request')});
 assert.equal((await engine.fetchSource({title:'Inflation next month'},'bls')).status.status,'No relevant data');
 assert.match(validateMapping('bls',{...bls,seriesIds:['GUESS']}),/series/);
 assert.match(validateMapping('nws',{...nws,station:null}),/station/);
 assert.match(validateMapping('fred',{...fred,vintage:'bad'}),/vintage/);
 assert.match(validateMapping('sec',{...sec,company:''}),/Unresolved/);
 assert.equal(mappingFor({title:'CUUR0000SA0 for 2025'}).find(p=>p.key==='bls').mapping.startYear,2025);
});
test('BLS POST validates status, preserves notes, units, nulls and caching',async()=>{
 let calls=0;let clock=1000000;let fail=false;
 const engine=make(async(url,options)=>{calls++;assert.equal(url,'https://api.bls.gov/publicAPI/v2/timeseries/data/');assert.equal(options.method,'POST');assert.equal(JSON.parse(options.body).registrationkey,'fixture-secret');return json(fail?{status:'REQUEST_FAILED'}:data);},{BLS_API_KEY:'fixture-secret'},{now:()=>clock});
 let result=await engine.fetchSource(event,'bls',{FIXTURE:{bls}});
 assert.equal(result.status.status,'Retrieved');assert.equal(result.articles[0].observations[1].value,null);assert.equal(result.articles[0].observations[0].footnotes[0].code,'P');assert.match(result.articles[0].units,/Index/);
 assert.equal((await engine.fetchSource(event,'bls',{FIXTURE:{bls}})).status.status,'Cached');assert.equal(calls,1);
 clock+=3600001;fail=true;result=await engine.fetchSource(event,'bls',{FIXTURE:{bls}});assert.equal(result.status.status,'Error');assert.equal(result.articles.length,0);assert.equal(calls,2);
});
test('rate limits honor cooldown and redact upstream errors',async()=>{
 let calls=0;const engine=make(async()=>{calls++;return new Response('secret',{status:429,headers:{'Retry-After':'60'}});});
 const a=await engine.fetchSource(event,'bls',{FIXTURE:{bls}});const b=await engine.fetchSource(event,'bls',{FIXTURE:{bls}});
 assert.equal(calls,1);assert.match(a.status.reason,/429/);assert.match(b.status.reason,/Rate limited/);assert.equal(a.articles.length,0);
});
test('FRED first release and as-of vintage use documented parameters and metadata',async()=>{
 const requests=[];const engine=make(async(url)=>{const u=new URL(url);requests.push(u);assert.equal(u.searchParams.get('api_key'),'fixture-fred-secret');
 if(u.pathname==='/fred/series')return json({seriess:[{id:'CPIAUCNS',title:'CPI',units:'Index',frequency:'Monthly',seasonal_adjustment:'Not Seasonally Adjusted'}]});
 if(u.pathname.endsWith('/observations'))return json({count:1,observations:[{date:'2025-01-01',value:'317',realtime_start:'2025-02-12',realtime_end:'2025-02-12'}]});
 if(u.pathname.endsWith('/release'))return json({releases:[{id:10}]});
 return json({sources:[{name:'BLS',link:'https://www.bls.gov'}]});
 },{FRED_API_KEY:'fixture-fred-secret'});
 const result=await engine.fetchSource(event,'fred',{FIXTURE:{fred}});assert.equal(result.status.status,'Retrieved');assert.equal(requests.find(u=>u.pathname.endsWith('/observations')).searchParams.get('output_type'),'4');assert.equal(result.articles[0].frequency,'Monthly');assert.doesNotMatch(JSON.stringify(result),/fixture-fred-secret/);
 requests.length=0;await engine.fetchSource(event,'fred',{FIXTURE:{fred:{...fred,firstRelease:false,vintage:'2025-03-01'}}});assert.equal(requests.find(u=>u.pathname.endsWith('/observations')).searchParams.get('realtime_start'),'2025-03-01');
});
test('SEC verifies CIK/company, retrieves filing contents and matches facts to accession',async()=>{
 const urls=[];const engine=make(async(url,options)=>{urls.push(url);assert.match(options.headers['User-Agent'],/fixture@example.org/);
 if(url.includes('/submissions/'))return json({cik:320193,name:'Apple Inc.',filings:{recent:{accessionNumber:['0000320193-24-000123'],primaryDocument:['report.htm'],form:['10-K'],reportDate:['2024-09-28'],filingDate:['2024-11-01']}}});
 if(url.includes('companyfacts'))return json({cik:320193,facts:{'us-gaap':{Revenues:{label:'Revenue',units:{USD:[{accn:'0000320193-24-000123',end:'2024-09-28',val:100}]}}}}});
 return new Response('<main>Fixture historical financial results and forward looking risks for the selected company and period.</main>');
 },{DATA_SOURCE_CONTACT_EMAIL:'fixture@example.org'});
 const result=await engine.fetchSource(event,'sec',{FIXTURE:{sec}});assert.equal(result.status.status,'Retrieved');assert.ok(result.articles.some(a=>a.content.includes('Fixture historical')));assert.equal(urls.length,3);
 const bad=await engine.fetchSource(event,'sec',{FIXTURE:{sec:{...sec,company:'Other company'}}});assert.equal(bad.status.status,'Error');assert.equal(bad.articles.length,0);
});
test('NWS works without contact and follows exact station, timezone, period and freshness',async()=>{
 const engine=make(async(url,options)=>{
 assert.equal(options.headers['User-Agent'],'Fieldnote-Kalshi-Research/0.1 (local analysis backend)');
 if(url.includes('/points/'))return json({properties:{timeZone:'America/New_York',observationStations:'https://api.weather.gov/gridpoints/OKX/1,1/stations'}});
 if(url.endsWith('/stations'))return json({features:[{id:'https://api.weather.gov/stations/KNYC',properties:{stationIdentifier:'KNYC'}}]});
 return json({features:[{properties:{timestamp:'2025-01-01T12:00:00Z',temperature:{value:null,unitCode:'wmoUnit:degC'}}}]});
 },{},{now:()=>Date.parse('2026-10-05')});
 const result=await engine.fetchSource(event,'nws',{FIXTURE:{nws}});assert.equal(result.status.status,'Retrieved');assert.equal(result.articles[0].observations[0].temperature.value,null);assert.equal(result.articles[0].stale,true);
 const wrong=await engine.fetchSource(event,'nws',{FIXTURE:{nws:{...nws,station:'KJFK'}}});assert.equal(wrong.status.status,'Error');
});
test('SportsDB free lookup excludes unrelated matches and empty tennis coverage',async()=>{
 const engine=make(async url=>{assert.match(url,/\/123\/lookupevent.php/);return json({events:[{idEvent:'12345',strSport:'Soccer',strLeague:'Fixture Open',strHomeTeam:'Player A',strAwayTeam:'Player B',dateEvent:'2025-01-01'}]});},{SPORTSDB_API_KEY:'123'});
 assert.equal((await engine.fetchSource(event,'sports',{FIXTURE:{sports}})).status.status,'Error');
 const empty=make(async()=>json({events:null}),{SPORTSDB_API_KEY:'123'});assert.equal((await empty.fetchSource(event,'sports',{FIXTURE:{sports}})).status.status,'No relevant data');
});
test('one source timing out does not lose another source’s evidence',async()=>{
 const engine=make(async(url)=>{if(url.includes('federalreserve'))throw new DOMException('fixture timeout','TimeoutError');return json(data);});
 const mappings={FIXTURE:{bls,fed:{kind:'monetary'}}};const [a,b]=await Promise.all(['fed','bls'].map(key=>engine.fetchSource(event,key,mappings)));
 assert.equal(a.status.status,'Error');assert.equal(b.status.status,'Retrieved');assert.ok(b.articles.length);
});

test('NWS forecast is labeled separately and filters the requested period',async()=>{
 const map={...nws,kind:'forecast',units:'F'};
 const engine=make(async url=>url.includes('/points/')?json({properties:{timeZone:'America/New_York',forecastHourly:'https://api.weather.gov/gridpoints/OKX/1,1/forecast/hourly'}}):json({properties:{generatedAt:'2025-01-01T00:00:00Z',periods:[{startTime:'2025-01-01T01:00:00Z',endTime:'2025-01-01T02:00:00Z',temperature:40,temperatureUnit:'F'},{startTime:'2025-01-03T01:00:00Z',endTime:'2025-01-03T02:00:00Z',temperature:40,temperatureUnit:'F'}]}}),{DATA_SOURCE_CONTACT_EMAIL:'fixture@example.org'});
 const result=await engine.fetchSource(event,'nws',{FIXTURE:{nws:map}});assert.equal(result.status.status,'Retrieved');assert.equal(result.articles[0].observations.length,1);assert.match(result.articles[0].limitations[0],/Forecast, not an observation/);
});
test('valid SportsDB fixture retains missing scores as null',async()=>{
 const engine=make(async()=>json({events:[{idEvent:'12345',strEvent:'Fixture match',strSport:'Tennis',strLeague:'Fixture Open',strHomeTeam:'Player A',strAwayTeam:'Player B',dateEvent:'2025-01-01',intHomeScore:null,intAwayScore:''}]}),{SPORTSDB_API_KEY:'123'});
 const result=await engine.fetchSource(event,'sports',{FIXTURE:{sports}});assert.equal(result.status.status,'Retrieved');assert.equal(result.articles[0].observations.homeScore,null);assert.equal(result.articles[0].observations.awayScore,null);
});
test('invalid JSON and HTTP denial are not successful retrievals',async()=>{
 for(const response of [()=>new Response('bad json'),()=>new Response('denied',{status:403})]){
  const engine=make(async()=>response());const result=await engine.fetchSource(event,'bls',{FIXTURE:{bls}});assert.equal(result.status.status,'Error');assert.equal(result.articles.length,0);
 }
});

test('Fed RSS fixture reads links from the official directory and labels summaries',async()=>{
 const urls=[];
 const engine=make(async url=>{urls.push(url);return url.endsWith('feeds.htm')?new Response('<a href="/feeds/press_monetary.xml">Monetary policy</a>'):new Response('<rss><channel><item><title>Fixture announcement</title><link>https://www.federalreserve.gov/newsevents/pressreleases/monetary20260101a.htm</link><pubDate>Thu, 01 Jan 2026 12:00:00 GMT</pubDate><description><![CDATA[<p>Fixture summary only.</p>]]></description></item></channel></rss>');});
 const result=await engine.fetchSource(event,'fed',{FIXTURE:{fed:{kind:'monetary'}}});assert.equal(result.status.status,'Retrieved');assert.equal(urls.length,2);assert.equal(result.articles[0].content,'Fixture summary only.');assert.match(result.articles[0].access,/RSS summary only/);assert.match(result.articles[0].publishedAt,/2026/);
});

test('irrelevant sources do not report missing credentials as a market problem',()=>{
 const engine=make(()=>{throw Error('Must not request irrelevant sources');});
 const rows=engine.status({title:'Bitcoin price tomorrow'});
 assert.ok(rows.every(row=>row.status==='No relevant data'));
 assert.ok(rows.every(row=>row.relevant===false));
});
