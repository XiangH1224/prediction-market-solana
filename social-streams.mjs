import {createHash} from 'node:crypto';
import {readFileSync,existsSync,writeFileSync,renameSync} from 'node:fs';
import {createSocialCache,originUrl,validScope} from './social-evidence.mjs';
const CONFIG=new URL('./social-monitoring.local.json',import.meta.url),STATE=new URL('./.social-state.json',import.meta.url);
const BS='https://public.api.bsky.app/xrpc/';
const X='https://api.x.com/2/';
export function readSocialConfig(){try{if(!existsSync(CONFIG))return {};const raw=readFileSync(CONFIG,'utf8');if(raw.length>100000)throw Error();const value=JSON.parse(raw);return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}catch{return {};}}
export function createSocialService({env=process.env,config=readSocialConfig(),fetcher=fetch,Socket=globalThis.WebSocket,now=Date.now,stateFile=STATE}={}) {
 const cache=createSocialCache(config,{now});
 const state={bluesky:{connected:false,lastEventAt:null,gaps:[]},x:{connected:false,lastEventAt:null,gaps:[]}};
 let disk={cursor:0,budget:{}},stateReadable=true;try{if(stateFile&&existsSync(stateFile))disk=JSON.parse(readFileSync(stateFile,'utf8'));if(!disk||typeof disk!=='object'||Array.isArray(disk))throw Error();}catch{disk={cursor:0,budget:{}};stateReadable=false;}
 const fingerprint=createHash('sha256').update(JSON.stringify(config)).digest('hex');
 if(disk.scope!==fingerprint||!Number.isSafeInteger(disk.cursor)||disk.cursor<0)disk.cursor=0;disk.scope=fingerprint;
 const budgetValid=stateReadable && (!disk.budget?.day||['posts','requests','usd'].every(k=>Number.isFinite(disk.budget[k])&&disk.budget[k]>=0));
 const retryAt={bluesky:0,x:0};
 const allowed=new Set();const handles=new Map();let stopped=false,socket,bsTimer,xTimer,watchdog,xAbort,lastFrame=0,backoff=1000;
 const timers=new Set();const later=(fn,ms)=>{const timer=setTimeout(()=>{timers.delete(timer);fn();},ms);timer.unref?.();timers.add(timer);return timer;};
 const persist=()=>{if(!stateFile)return;const temp=new URL(`${stateFile.pathname}.tmp`,stateFile);writeFileSync(temp,JSON.stringify(disk),{mode:0o600});renameSync(temp,stateFile);};
 const gap=(provider,reason)=>{const s=state[provider];s.connected=false;s.gaps.push({at:new Date(now()).toISOString(),reason});s.gaps=s.gaps.slice(-50);cache.clear(provider==='bluesky'?'Bluesky':'X');};
 const scoped=()=>Object.values(config.markets||{}).some(validScope);
 const accounts=()=>Array.isArray(config.bluesky?.accounts)?config.bluesky.accounts.filter(v=>typeof v==='string').slice(0,100):[];
 const terms=()=>Array.isArray(config.bluesky?.terms)?config.bluesky.terms.filter(v=>typeof v==='string'&&v.length>=2).slice(0,30):[];
 const bsEnabled=()=>accounts().length>0&&terms().length>0&&scoped();
 const xEnabled=()=>budgetValid && ['X_USAGE_BUDGET_USD','X_MAX_POSTS_PER_DAY','X_MAX_REQUESTS_PER_DAY','X_POST_COST_CEILING_USD','X_REQUEST_COST_CEILING_USD'].every(k=>Number.isFinite(Number(env[k]))) && env.X_STREAM_ENABLED==='true' && env.X_PAID_ACCESS_ENABLED==='true' && env.X_PLATFORM_SPEND_LIMIT_CONFIRMED==='true' && Boolean(env.X_BEARER_TOKEN) && Number(env.X_USAGE_BUDGET_USD)>0 && Number(env.X_MAX_POSTS_PER_DAY)>0 && Number(env.X_MAX_REQUESTS_PER_DAY)>0 && Number(env.X_POST_COST_CEILING_USD)>0 && Number(env.X_REQUEST_COST_CEILING_USD)>0 && Array.isArray(config.x?.rules)&&config.x.rules.length>0&&config.x.rules.length<=10&&config.x.rules.every(r=>typeof r==='string'&&r.length<=1024) && Array.isArray(config.x?.authorIds)&&config.x.authorIds.length>0&&config.x.authorIds.every(id=>/^\d+$/.test(id)) && scoped();
 function reserve(kind,count=1){if(!xEnabled())throw Error('X disabled');const day=new Date(now()).toISOString().slice(0,10);if(disk.budget?.day!==day)disk.budget={day,posts:0,requests:0,usd:0};const b=disk.budget,cost=count*Number(env[kind==='posts'?'X_POST_COST_CEILING_USD':'X_REQUEST_COST_CEILING_USD']);if(b[kind]+count>Number(env[kind==='posts'?'X_MAX_POSTS_PER_DAY':'X_MAX_REQUESTS_PER_DAY'])||b.usd+cost>Number(env.X_USAGE_BUDGET_USD))throw Error('X budget exhausted');b[kind]+=count;b.usd+=cost;persist();}
 async function json(url,provider='bluesky',options={}) {
  if(now()<retryAt[provider])throw Error('Provider cooldown');
  if(provider==='x')reserve('requests');
  const r=await fetcher(url,{...options,signal:AbortSignal.timeout(10000),redirect:'error',headers:{Accept:'application/json',...(provider==='x'?{Authorization:`Bearer ${env.X_BEARER_TOKEN}`}:{})}});
  if(!r.ok){const error=Error(`HTTP ${r.status}`);error.retryMs=Math.max(60000,Number(r.headers.get('retry-after'))*1000||Date.parse(r.headers.get('retry-after'))-now()||0);retryAt[provider]=now()+error.retryMs;throw error;}
  const reader=r.body.getReader(),decoder=new TextDecoder();let text='',size=0;try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>1000000)throw Error('Response too large');text+=decoder.decode(value,{stream:true});}return JSON.parse(text+decoder.decode());}finally{await reader.cancel();}
 }
 async function resolveAccounts(){allowed.clear();for(const account of accounts()){
  const did=/^did:(plc:[a-z2-7]+|web:[a-zA-Z0-9.:%-]+)$/.test(account)?account:(await json(`${BS}com.atproto.identity.resolveHandle?${new URLSearchParams({handle:account})}`)).did;
  if(typeof did!=='string'||!/^did:(plc|web):/.test(did))throw Error('Invalid resolved DID');allowed.add(did);handles.set(did,account.startsWith('did:')?null:account);
 }}
 function consumeBluesky(envelope){const e=envelope.payload||envelope;const kind=e.kind||String(e.$type||'').split('#').at(-1);if(!allowed.has(e.did)||!Number.isSafeInteger(e.seq)||e.seq<=disk.cursor)return;
  state.bluesky.lastEventAt=new Date(now()).toISOString();disk.cursor=e.seq;
  if(kind==='account' && (e.account?.active===false||e.active===false) || kind==='sync'){cache.clear('Bluesky',e.did);}
  if(kind==='identity'){cache.clear('Bluesky',e.did);handles.set(e.did,e.identity?.handle||null);}
  if(kind==='commit') {const c=e.commit||e;if(c.collection==='app.bsky.feed.post'&&typeof c.rkey==='string'&&/^[a-zA-Z0-9._~:-]+$/.test(c.rkey)){
   const key=`at://${e.did}/app.bsky.feed.post/${c.rkey}`;cache.remove(key);
   if(c.operation!=='delete'&&typeof c.record?.text==='string'&&terms().some(term=>c.record.text.toLowerCase().includes(term.toLowerCase()))){
    const record=c.record;const link=record.facets?.flatMap(f=>f.features||[]).find(f=>f.$type==='app.bsky.richtext.facet#link')?.uri || record.embed?.external?.uri;
    cache.put({key,provider:'Bluesky',postId:key,authorId:e.did,authorHandle:handles.get(e.did),url:`https://bsky.app/profile/${e.did}/post/${c.rkey}`,text:record.text,publishedAt:record.createdAt,retrievedAt:new Date(now()).toISOString(),originUrl:originUrl(link)});
   }
  }}persist();
 }
 async function connectBluesky(){if(stopped||!bsEnabled())return;try{
  await resolveAccounts();if(stopped||!allowed.size)return;
  const url=new URL('wss://jetstream.us-east.bsky.network/xrpc/network.bsky.jetstream.subscribeEvents');url.searchParams.append('collections','app.bsky.feed.post');for(const did of allowed)url.searchParams.append('dids',did);if(disk.cursor)url.searchParams.set('cursor',String(disk.cursor));
  socket=new Socket(url.href,['xrpc.v1.json']);const current=socket;let opened=false;
  const timeout=later(()=>{if(!opened)current.close();},15000);
  current.addEventListener('open',()=>{opened=true;clearTimeout(timeout);state.bluesky.connected=true;lastFrame=now();backoff=1000;});
  current.addEventListener('message',event=>{lastFrame=now();try{if(typeof event.data!=='string'||event.data.length>65536)return;const message=JSON.parse(event.data);if(message.$type==='error'){gap('bluesky','Server rejected stream or resume cursor');disk.cursor=0;persist();current.close();return;}consumeBluesky(message);}catch{gap('bluesky','Invalid event or state write failure');current.close();}});
  current.addEventListener('error',()=>{gap('bluesky','Connection error');current.close();});
  current.addEventListener('close',()=>{clearTimeout(timeout);gap('bluesky','Disconnected; cached claims invalidated');if(!stopped){bsTimer=later(connectBluesky,backoff);backoff=Math.min(backoff*2,60000);}});
  watchdog=setInterval(()=>{cache.prune();if(state.bluesky.connected&&now()-lastFrame>300000)current.close();},30000);watchdog.unref?.();current.addEventListener('close',()=>clearInterval(watchdog),{once:true});
 }catch{gap('bluesky','Handle resolution or connection failed');if(!stopped)bsTimer=later(connectBluesky,60000);}}
 function consumeX(message){if(!xEnabled())return;
  const p=message.data;if(!p)return;
  reserve('posts');state.x.lastEventAt=new Date(now()).toISOString();
  for(const id of p.edit_history_tweet_ids||[])cache.remove(`x:${id}`);
  if(!config.x.authorIds.includes(p.author_id)||!/^\d+$/.test(p.id))return;
  cache.put({key:`x:${p.id}`,provider:'X',postId:p.id,authorId:p.author_id,text:p.text,publishedAt:p.created_at,retrievedAt:new Date(now()).toISOString(),url:`https://x.com/i/web/status/${p.id}`,originUrl:originUrl(p.entities?.urls?.[0]?.expanded_url)});
 }
 async function connectX(){if(stopped||!xEnabled())return;let idle;
  try {
   // Do not silently mutate another application's project-wide rules.
   const rules=await json(`${X}tweets/search/stream/rules`,'x');
   if(!Array.isArray(rules.data)||rules.data.length!==config.x.rules.length||rules.data.some(r=>!config.x.rules.includes(r.value)))throw Error('Configured X rules do not match project rules');
   if(stopped)return;
   reserve('requests');xAbort=new AbortController();idle=setTimeout(()=>xAbort.abort(),20000);
   const response=await fetcher(`${X}tweets/search/stream?tweet.fields=author_id,created_at,entities,edit_history_tweet_ids`,{headers:{Authorization:`Bearer ${env.X_BEARER_TOKEN}`},signal:xAbort.signal,redirect:'error'});
   if(!response.ok){const err=Error('X stream rejected');err.retryMs=Math.max(60000,Number(response.headers.get('retry-after'))*1000||0);throw err;}
   state.x.connected=true;const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
   while(!stopped){const {value,done}=await reader.read();if(done)break;clearTimeout(idle);idle=setTimeout(()=>xAbort.abort(),20000);buffer+=decoder.decode(value,{stream:true});if(buffer.length>65536)throw Error('X frame limit');let at;while((at=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,at).trim();buffer=buffer.slice(at+1);if(line)consumeX(JSON.parse(line));}}
   throw Error('X stream ended');
  }catch(error){gap('x','Stream unavailable, rules mismatch, or budget exhausted; no gap backfill claimed');if(!stopped)xTimer=later(connectX,Math.max(60000,error.retryMs||0));}finally{clearTimeout(idle);xAbort?.abort();}
 }
 // Rehydrate selected records at analysis time: covers deletion, missed edits and account takedowns.
 async function validated(event,ids){let selected=cache.select(event);if(ids)selected=selected.filter(p=>ids.includes(p.id));const result=[];
  for(const provider of ['Bluesky','X']){const subset=selected.filter(p=>p.provider===provider);if(!subset.length)continue;
   if(provider==='Bluesky'&&!state.bluesky.connected||provider==='X'&&(!state.x.connected||!xEnabled()))continue;
   try {let live;
    if(provider==='Bluesky'){const q=new URLSearchParams();for(const p of subset)q.append('uris',p.key);live=(await json(`${BS}app.bsky.feed.getPosts?${q}`)).posts||[];}
    else {reserve('posts',subset.length);live=(await json(`${X}tweets?${new URLSearchParams({ids:subset.map(p=>p.postId).join(','),'tweet.fields':'author_id,created_at,edit_history_tweet_ids'})}`,'x')).data||[];}
    for(const p of subset){const found=live.find(v=>provider==='Bluesky'?v.uri===p.key:v.id===p.postId);const text=provider==='Bluesky'?found?.record?.text:found?.text;const author=provider==='Bluesky'?found?.author?.did:found?.author_id;
     if(!found||text!==p.text||author!==p.authorId||(provider==='X'&&found.edit_history_tweet_ids?.at(-1)!==p.postId)){cache.remove(p.key);continue;}
     if(cache.get(p.id)&&cache.select(event).some(v=>v.id===p.id))result.push(cache.evidence({...p,retrievedAt:new Date(now()).toISOString()}));
    }
   }catch{gap(provider==='Bluesky'?'bluesky':'x','Post revalidation failed; evidence withheld');if(provider==='Bluesky')socket?.close();else xAbort?.abort();}
  }return {articles:result,diagnostics:{bluesky:{enabled:bsEnabled(),...state.bluesky},x:{enabled:xEnabled(),...state.x},revision:cache.revision}};
 }
 return {start(){stopped=false;const prune=()=>{if(stopped)return;cache.prune();later(prune,60000);};later(prune,60000);void connectBluesky();void connectX();},stop(){stopped=true;for(const t of timers)clearTimeout(t);clearTimeout(bsTimer);clearTimeout(xTimer);clearInterval(watchdog);socket?.close();xAbort?.abort();cache.clear('Bluesky');cache.clear('X');},validated,consumeBluesky,consumeX,cache,state,resolveAccounts,xEnabled,bsEnabled};
}
