import test from 'node:test';
import assert from 'node:assert/strict';
import {researchPlan,isRecordUrl} from '../research-directory.js';

test('source selection is relevant and directory pages are never records',()=>{
  assert.equal(researchPlan({title:'Will Bitcoin exceed $100,000?'}).records.length,0);
  assert.equal(researchPlan({title:'Will Bitcoin exceed $100,000?'}).directory.length,0);
  const plan=researchPlan({title:'US CPI inflation in November'});
  assert.deepEqual(plan.records.map(r=>r.source),['BLS']);
  for(const url of ['https://www.bls.gov/developers/','https://www.sec.gov/search-filings','https://fred.stlouisfed.org/','https://www.thesportsdb.com/docs_api','http://www.bls.gov/news.release/cpi.nr0.htm','https://www.bls.gov.evil.test/news.release/cpi.nr0.htm','https://user@www.bls.gov/news.release/cpi.nr0.htm']) assert.equal(isRecordUrl(url),false,url);
});

test('settlement record is first and deduplicated against reporting links',()=>{
  const url='https://www.sec.gov/Archives/edgar/data/123/456/results.htm';
  const plan=researchPlan({title:'Quarterly revenue',sourceUrl:url},[{url}]);
  assert.equal(plan.records.length,1);
  assert.equal(plan.records[0].settlementSource,true);
});

