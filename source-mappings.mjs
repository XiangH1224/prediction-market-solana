export const PROVIDERS=['Federal Reserve','BLS','FRED / ALFRED','SEC EDGAR','National Weather Service','TheSportsDB'];
export const SERIES={
  CUUR0000SA0:{provider:'BLS',title:'US CPI-U all items, US city average',units:'Index 1982–1984=100',adjustment:'Not seasonally adjusted'},
  CUSR0000SA0:{provider:'BLS',title:'US CPI-U all items, US city average',units:'Index 1982–1984=100',adjustment:'Seasonally adjusted'},
  LNS14000000:{provider:'BLS',title:'US civilian unemployment rate',units:'Percent',adjustment:'Seasonally adjusted'},
  CES0000000001:{provider:'BLS',title:'US total nonfarm payroll employment',units:'Thousands of persons',adjustment:'Seasonally adjusted'},
  CPIAUCSL:{provider:'FRED / ALFRED'}, CPIAUCNS:{provider:'FRED / ALFRED'}, UNRATE:{provider:'FRED / ALFRED'}, PAYEMS:{provider:'FRED / ALFRED'}, DFEDTARU:{provider:'FRED / ALFRED'}, DFEDTARL:{provider:'FRED / ALFRED'}, DFF:{provider:'FRED / ALFRED'}
};
const validDate=s=>typeof s==='string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0,10)===s;
export function mappingFor(event,overrides={}) {
  const text=[event.title,event.eventTitle,event.rules,event.sourceName,event.sourceUrl].filter(Boolean).join(' ');
  const map=structuredClone(overrides[event.marketTicker] || {});
  const explicit=Object.keys(SERIES).filter(id=>new RegExp(`\\b${id}\\b`).test(text));
  const years=[...new Set(text.match(/\b20\d{2}\b/g)||[])].map(Number);
  // Infer only exact series IDs and a single explicit year. Broad topic words only route.
  for(const [key,provider] of [['bls','BLS'],['fred','FRED / ALFRED']]) {
    const ids=explicit.filter(id=>SERIES[id].provider===provider);
    if(!map[key] && ids.length===1 && years.length===1) map[key]=key==='bls' ? {seriesIds:ids,startYear:years[0],endYear:years[0]} : {seriesId:ids[0],start:`${years[0]}-01-01`,end:`${years[0]}-12-31`};
  }
  if(/first[- ]release|initial release|as originally (?:published|reported)/i.test(text)) {if(map.fred) map.fred.firstRelease=true; if(map.bls) map.bls.firstReleaseRequired=true;}
  const topics={
    'Federal Reserve':/federal reserve|fomc|fed funds|interest rate|monetary policy/i,
    BLS:/\bcpi\b|inflation|employment|unemployment|payroll/i,
    'FRED / ALFRED':/\bcpi\b|inflation|employment|unemployment|payroll|interest rate|fed funds|fomc|\bfred\b|alfred/i,
    'SEC EDGAR':/earnings|revenue|company|\bsec\b|edgar|10-k|10-q|8-k/i,
    'National Weather Service':/weather|temperature|rainfall|snowfall|precipitation|hurricane/i,
    TheSportsDB:/sports|tennis|soccer|football|basketball|baseball|world cup|goals|\bnba\b|\bnfl\b|\bmlb\b|\bnhl\b/i
  };
  const keys=['fed','bls','fred','sec','nws','sports'];
  return PROVIDERS.map((source,i)=>({source,key:keys[i],relevant:Boolean(map[keys[i]] || topics[source].test(text) || explicit.some(id=>SERIES[id].provider===source)),mapping:map[keys[i]] || (i===0 ? {kind:/speech|remarks/i.test(text)?'speeches':'monetary'} : null)}));
}
export function validateMapping(key,m) {
  if(!m || typeof m!=='object') return 'Unresolved mapping: add exact identifiers and period for this market ticker.';
  if(key==='fed') return ['monetary','speeches'].includes(m.kind) ? '' : 'Invalid Federal Reserve feed kind.';
  if(key==='bls') {
    if(!Array.isArray(m.seriesIds) || !m.seriesIds.length || m.seriesIds.length>4 || m.seriesIds.some(id=>SERIES[id]?.provider!=='BLS')) return 'Unresolved BLS series; use a supported catalog ID.';
    if(!Number.isInteger(m.startYear)||!Number.isInteger(m.endYear)||m.startYear<1900||m.endYear<m.startYear||m.endYear>new Date().getUTCFullYear()+1||m.endYear-m.startYear>9) return 'Invalid BLS year range (maximum ten years).';
  }
  if(key==='fred') {
    if(SERIES[m.seriesId]?.provider!=='FRED / ALFRED') return 'Unresolved FRED series; use a supported catalog ID.';
    if(!validDate(m.start)||!validDate(m.end)||m.start>m.end) return 'Invalid FRED observation period.';
    if(m.vintage && !validDate(m.vintage)) return 'Invalid ALFRED vintage date.';
    if(m.firstRelease && m.vintage) return 'Choose first-release data or an as-of vintage, not both.';
  }
  if(key==='sec') {
    if(!/^\d{1,10}$/.test(String(m.cik||'')) || !m.company || !['10-K','10-Q','8-K'].includes(m.form) || !validDate(m.reportDate)) return 'Unresolved SEC mapping: CIK, exact company name, form and reportDate are required.';
    if(m.concepts && (!Array.isArray(m.concepts)||m.concepts.length>4||m.concepts.some(c=>!/^[A-Za-z][A-Za-z0-9]*$/.test(c)))) return 'Invalid SEC concept mapping.';
  }
  if(key==='nws') {
    if(!['temperature','precipitationLastHour','precipitationLast3Hours','precipitationLast6Hours','windSpeed','barometricPressure'].includes(m.measurement) || (m.kind==='forecast' && m.measurement!=='temperature')) return 'Unsupported or unresolved NWS measurement; forecasts currently support temperature only.';
    if(typeof m.latitude!=='number'||!Number.isFinite(m.latitude)||Math.abs(m.latitude)>90||typeof m.longitude!=='number'||!Number.isFinite(m.longitude)||Math.abs(m.longitude)>180||!m.location||!m.timeZone||!m.units||!['forecast','observation'].includes(m.kind)) return 'Unresolved NWS mapping: exact coordinates, location, timeZone, units and kind required.';
    if(!Number.isFinite(Date.parse(m.start))||!Number.isFinite(Date.parse(m.end))||Date.parse(m.start)>=Date.parse(m.end)||!/[Zz]|[+-]\d\d:\d\d$/.test(m.start)||!/[Zz]|[+-]\d\d:\d\d$/.test(m.end)) return 'NWS period requires timestamps with explicit time zones.';
    if(m.kind==='observation'&&!/^[A-Z0-9]{3,8}$/.test(m.station||'')) return 'Exact settlement station is required; nearest station is not substituted.';
  }
  if(key==='sports' && (!/^\d+$/.test(String(m.eventId||''))||!m.sport||!m.league||!m.home||!m.away||!validDate(m.date))) return 'Unresolved sports mapping: exact event ID, sport, league, participants and date required.';
  return '';
}
