// Read-only live smoke checks; no fixture data is returned by this script.
import './backend-config.mjs';
import {createDataSources} from './data-sources.mjs';
const now=new Date();
const yesterday=new Date(now.getTime()-86400000).toISOString();
const mappings={VERIFY:{
 fed:{kind:'monetary'},
 bls:{seriesIds:['CUUR0000SA0'],startYear:2025,endYear:2025},
 fred:{seriesId:'CPIAUCNS',start:'2025-01-01',end:'2025-12-31',firstRelease:true},
 sec:{cik:'320193',company:'Apple Inc.',form:'10-K',reportDate:'2024-09-28',concepts:['RevenueFromContractWithCustomerExcludingAssessedTax'],filingText:true},
 nws:{latitude:40.7789,longitude:-73.9692,location:'Central Park, New York',station:'KNYC',timeZone:'America/New_York',units:'wmoUnit:degC',measurement:'temperature',kind:'observation',start:yesterday,end:now.toISOString()},
 sports:{eventId:'441613',sport:'Soccer',league:'English Premier League',home:'Liverpool',away:'Swansea',date:'2014-12-29'}
}};
const engine=createDataSources();
for(const key of ['fed','bls','fred','sec','nws','sports']) {
 const result=await engine.fetchSource({marketTicker:'VERIFY'},key,mappings);
 console.log(JSON.stringify({provider:result.status.source,status:result.status.status,reason:result.status.reason,retrievedAt:result.status.retrievedAt,evidenceCount:result.articles.length,sourceUrls:result.articles.map(a=>a.url)}));
 if(result.status.status==='Error') process.exitCode=1;
}
