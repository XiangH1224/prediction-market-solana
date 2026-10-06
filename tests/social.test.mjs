// All posts and HTTP responses in this file are synthetic fixtures, never live evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createSocialCache} from '../social-evidence.mjs';
import {createSocialService} from '../social-streams.mjs';
import {analyzeLocally,fetchRecentCoverage} from '../integrations.js';
const at=Date.now(),stamp=new Date(at).toISOString(),did='did:plc:abcdefghijklmnopqrstuvwx';
const event={marketTicker:'FIXTURE',title:'Will Fixture FC win the Fixture Cup in Paris on October 6?',rules:'Fixture winner only'};
const scope={question:event.title,settlementRules:event.rules,participants:[['Fixture FC']],event:['Fixture Cup'],condition:['wins','win'],dates:['October 6'],location:['Paris'],startAt:new Date(at-86400000).toISOString(),endAt:new Date(at+86400000).toISOString()};
const config={bluesky:{accounts:[did],terms:['Fixture Cup']},markets:{FIXTURE:scope}};
const text='Fixture FC wins Fixture Cup in Paris on October 6';
const post=(key='one',extra={})=>({key,provider:'Bluesky',postId:key,authorId:did,text,publishedAt:stamp,retrievedAt:stamp,url:'https://bsky.app/profile/'+did+'/post/'+key,...extra});
const envelope=(seq,operation='create',record={text,createdAt:stamp})=>({$type:'message',payload:{$type:'network.bsky.jetstream.subscribeEvents#commit',seq,did,collection:'app.bsky.feed.post',rkey:'one',operation,record}});
const json=data=>new Response(JSON.stringify(data));

test('strict relevance, duplicate origins, bounded storage and stale exclusion',()=>{
 const cache=createSocialCache(config,{now:()=>at,maxPosts:2});
 for(const bad of ['Fixture FC wins other cup in Paris on October 6','Other FC wins Fixture Cup in Paris on October 6','Fixture FC wins Fixture Cup in London on October 6','Fixture FC wins Fixture Cup in Paris on October 7'])cache.put(post('bad',{text:bad}));
 cache.put(post('stale',{publishedAt:new Date(at-3*86400000).toISOString()}));assert.equal(cache.size,0);
 cache.put(post('one',{originUrl:'https://example.com/claim'}));cache.put(post('two',{originUrl:'https://example.com/claim'}));assert.equal(cache.select(event).length,1);
 assert.equal(cache.select({...event,title:'Different market'}).length,0);
 cache.put(post('three',{text:text+' again'}));assert.equal(cache.size,2);
 cache.put(post('three',{text:'Unrelated edited post'}));assert.equal(cache.size,1);
});

test('disabled collectors and incomplete paid gates make zero requests',async()=>{
 let calls=0;const service=createSocialService({env:{X_STREAM_ENABLED:'true',X_BEARER_TOKEN:'fixture'},config:{},stateFile:null,fetcher:async()=>{calls++;throw Error();},Socket:class{constructor(){calls++;}}});
 service.start();await service.validated(event);service.consumeX({data:{id:'1'}});assert.equal(calls,0);assert.equal(service.xEnabled(),false);service.stop();
});

test('scoped subscription, commits, duplicate cursors, deletion and lookup invalidation',async()=>{
 let socket,url,calls=0,live=true;
 class Socket extends EventTarget {constructor(value){super();url=new URL(value);socket=this;}close(){this.dispatchEvent(new Event('close'));}}
 const service=createSocialService({env:{},config,stateFile:null,Socket,fetcher:async()=>{calls++;return json({posts:live?[{uri:`at://${did}/app.bsky.feed.post/one`,author:{did},record:{text}}]:[]});}});
 service.start();await new Promise(r=>setImmediate(r));
 assert.deepEqual(url.searchParams.getAll('dids'),[did]);assert.deepEqual(url.searchParams.getAll('collections'),['app.bsky.feed.post']);
 socket.dispatchEvent(new Event('open'));service.consumeBluesky(envelope(1));service.consumeBluesky(envelope(1,'delete'));assert.equal(service.cache.size,1);
 let result=await service.validated(event);assert.equal(result.articles.length,1);assert.match(result.articles[0].id,/^SOC-/);assert.equal(result.articles[0].author.id,did);
 live=false;result=await service.validated(event);assert.equal(result.articles.length,0);assert.equal(service.cache.size,0);
 service.consumeBluesky(envelope(2));service.consumeBluesky(envelope(3,'update',{text:'Unrelated',createdAt:stamp}));assert.equal(service.cache.size,0);
 service.consumeBluesky(envelope(4));service.consumeBluesky(envelope(5,'delete'));assert.equal(service.cache.size,0);
 service.consumeBluesky(envelope(6));service.consumeBluesky({payload:{$type:'network.bsky.jetstream.subscribeEvents#account',did,seq:7,active:false}});assert.equal(service.cache.size,0);
 service.stop();assert.equal(calls,2);
});

test('handle resolution and failed lookup withhold evidence without throwing',async()=>{
 const service=createSocialService({env:{},config:{...config,bluesky:{accounts:['fixture.example'],terms:['Fixture Cup']}},stateFile:null,fetcher:async url=>{if(String(url).includes('resolveHandle'))return json({did});return new Response('',{status:429,headers:{'Retry-After':'60'}});}});
 await service.resolveAccounts();service.state.bluesky.connected=true;service.consumeBluesky(envelope(1));const result=await service.validated(event);assert.deepEqual(result.articles,[]);assert.equal(result.diagnostics.bluesky.connected,false);assert.equal(service.cache.size,0);service.stop();
});

test('social evidence reaches unchanged model schema and revalidation failure preserves news',async context=>{
 const cache=createSocialCache(config);cache.put(post());const social=cache.evidence(cache.select(event)[0]);
 const news={id:'NEWS1',title:'Independent fixture report',url:'https://example.com/news',content:'Fixture report',date:stamp,provider:'GNews'};
 let available=true,requests=[];
 context.mock.method(globalThis,'fetch',async (url,options)=>{
  if(String(url).includes('/social?'))return available?json({articles:[social]}):new Response('',{status:503});
  if(String(url).includes('/chat/completions')){requests.push(JSON.parse(options.body));return json({choices:[{message:{content:'{}'}}]});}
  throw Error('Unexpected fixture request');
 });
 // Capture input even though the intentionally empty model response fails validation.
 await analyzeLocally({event,articles:[news,social],model:'fixture'}).catch(()=>{});
 let input=JSON.parse(requests[0].messages[1].content);assert.ok(input.evidence.some(a=>a.id===social.id&&a.social_post.author.id===did));
 const schema=structuredClone(requests[0].response_format.json_schema.schema);
 available=false;await analyzeLocally({event,articles:[news,social],model:'fixture'}).catch(()=>{});
 input=JSON.parse(requests[1].messages[1].content);assert.deepEqual(input.evidence.map(a=>a.id),['RULES','NEWS1']);assert.equal(requests[0].messages[0].content,requests[1].messages[0].content);
 assert.deepEqual(Object.keys(schema.properties),Object.keys(requests[1].response_format.json_schema.schema.properties));
});

test('persisted cursor resumes inclusive stream and reconnect clears cached claims',async()=>{
 const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {pathToFileURL}=await import('node:url');
 const dir=mkdtempSync(join(tmpdir(),'social-fixture-')),stateFile=pathToFileURL(join(dir,'state.json'));let socket,url;
 class Socket extends EventTarget {constructor(value){super();url=new URL(value);socket=this;}close(){this.dispatchEvent(new Event('close'));}}
 let service=createSocialService({env:{},config,stateFile,Socket});
 try{await service.resolveAccounts();service.consumeBluesky(envelope(41));service.stop();
 service=createSocialService({env:{},config,stateFile,Socket});service.start();await new Promise(r=>setImmediate(r));assert.equal(url.searchParams.get('cursor'),'41');socket.dispatchEvent(new Event('open'));service.consumeBluesky(envelope(42));assert.equal(service.cache.size,1);socket.close();assert.equal(service.cache.size,0);assert.ok(service.state.bluesky.gaps.length);}
 finally{service.stop();rmSync(dir,{recursive:true,force:true});}
});

test('paid fixture budgets enforce post cap and edits supersede previous IDs',()=>{
 const env={X_STREAM_ENABLED:'true',X_PAID_ACCESS_ENABLED:'true',X_PLATFORM_SPEND_LIMIT_CONFIRMED:'true',X_BEARER_TOKEN:'synthetic-only',X_USAGE_BUDGET_USD:'1',X_MAX_POSTS_PER_DAY:'2',X_MAX_REQUESTS_PER_DAY:'2',X_POST_COST_CEILING_USD:'0.1',X_REQUEST_COST_CEILING_USD:'0.1'};
 const service=createSocialService({env,config:{...config,x:{authorIds:['123'],rules:['from:fixture']}},stateFile:null});
 assert.equal(service.xEnabled(),true);
 service.consumeX({data:{id:'1',author_id:'123',text,created_at:stamp,edit_history_tweet_ids:['1']}});
 service.consumeX({data:{id:'2',author_id:'123',text:text+' updated',created_at:stamp,edit_history_tweet_ids:['1','2']}});
 assert.equal(service.cache.size,1);assert.equal(service.cache.select(event)[0].postId,'2');
 assert.throws(()=>service.consumeX({data:{id:'3'}}),/budget/);service.stop();
});

test('retrieval appends social alongside successful existing news and official evidence',async context=>{
 const cache=createSocialCache(config);cache.put(post());const social=cache.evidence(cache.select(event)[0]);
 context.mock.method(globalThis,'fetch',async url=>{
 const u=new URL(url);
 if(u.pathname==='/social')return json({articles:[social]});
 if(u.pathname==='/research'&&!u.searchParams.has('provider'))return json({gnewsConfigured:false,status:[{source:'BLS',key:'bls',status:'Ready'}]});
 if(u.pathname==='/research')return json({articles:[{id:'BLS-fixture',title:'Official fixture',url:'https://www.bls.gov/fixture'}],status:{source:'BLS',key:'bls',status:'Retrieved'}});
 return new Response('',{status:503});
 });
 const articles=await fetchRecentCoverage(event);assert.deepEqual(articles.map(a=>a.id),['BLS-fixture',social.id]);assert.ok(!articles.researchStatus.some(s=>/Bluesky|\bX\b/.test(s.source)));
});
