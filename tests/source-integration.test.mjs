// Synthetic integration responses: no live data or real credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchRecentCoverage} from '../integrations.js';
test('panel retrieval reports per-source progress and preserves successes when other sources fail',async context=>{
 const json=value=>new Response(JSON.stringify(value));
 context.mock.method(globalThis,'fetch',async url=>{
  const u=new URL(url);
  if(u.pathname==='/research'&&!u.searchParams.has('provider'))return json({gnewsConfigured:false,status:[{source:'BLS',key:'bls',status:'Ready'},{source:'Federal Reserve',key:'fed',status:'Ready'},{source:'FRED / ALFRED',key:'fred',status:'Not configured'}]});
  if(u.pathname==='/research'&&u.searchParams.get('provider')==='bls')return json({articles:[{id:'BLS-fixture',title:'Fixture CPI',url:'https://www.bls.gov/news.release/cpi.nr0.htm',provider:'BLS',content:'Fixture numeric evidence',retrievedAt:'2026-10-05T00:00:00Z'}],status:{source:'BLS',key:'bls',status:'Retrieved',retrievedAt:'2026-10-05T00:00:00Z'}});
  if(u.pathname==='/research')return json({articles:[],status:{source:'Federal Reserve',key:'fed',status:'Error',reason:'Fixture timeout'}});
  return new Response('Fixture news failure',{status:400});
 });
 const progress=[];const result=await fetchRecentCoverage({marketTicker:'FIXTURE',title:'Inflation',newsQuery:'fixture-inflation'},rows=>progress.push(rows));
 assert.equal(result.length,1);assert.equal(result[0].id,'BLS-fixture');
 assert.ok(progress.some(rows=>rows.some(r=>r.status==='Fetching')));
 assert.equal(result.researchStatus.find(r=>r.source==='Federal Reserve').status,'Error');
 assert.equal(result.researchStatus.find(r=>r.source==='BLS').status,'Retrieved');
 assert.equal(result.researchStatus.find(r=>r.source==='GNews').status,'Not configured');
 assert.equal(result.researchStatus.find(r=>r.source==='Google News RSS').status,'Error');
});

test('configuration retains the full source directory including irrelevant and unconfigured providers',async context=>{
 const {fetchSourceStatus}=await import('../integrations.js');
 context.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({gnewsConfigured:false,status:[{source:'Federal Reserve',key:'fed',relevant:false,status:'No relevant data'},{source:'TheSportsDB',key:'sports',relevant:true,status:'No relevant data',reason:'Exact event mapping required.'}]})));
 const rows=await fetchSourceStatus({title:'World Cup goals'});
 assert.deepEqual(rows.map(row=>row.source),['GNews','Google News RSS','Federal Reserve','TheSportsDB']);
 assert.equal(rows[0].status,'Not configured');
 assert.equal(rows[1].status,'Ready');
 assert.equal(rows[2].relevant,false);
});
