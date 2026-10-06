import {createHash} from 'node:crypto';
const normalized=value=>String(value||'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const has=(text,value)=>{const phrase=normalized(value);return phrase.length>=2 && ` ${normalized(text)} `.includes(` ${phrase} `);};
const list=value=>Array.isArray(value)&&value.length>0&&value.length<=20&&value.every(s=>typeof s==='string'&&s.length>=2&&s.length<=160);
export function validScope(scope) {
 return scope && typeof scope.question==='string' && scope.question.length>5 && typeof scope.settlementRules==='string' && scope.settlementRules.length>0 && Array.isArray(scope.participants)&&scope.participants.length>0&&scope.participants.length<=10&&scope.participants.every(list)&&list(scope.event)&&list(scope.condition)&&Array.isArray(scope.dates)&&scope.dates.length<=20&&scope.dates.every(s=>typeof s==='string'&&s.length>=2)&&Array.isArray(scope.location)&&scope.location.length<=20&&scope.location.every(s=>typeof s==='string'&&s.length>=2)&&Number.isFinite(Date.parse(scope.startAt))&&Number.isFinite(Date.parse(scope.endAt))&&Date.parse(scope.startAt)<Date.parse(scope.endAt);
}
export function matchesScope(post,scope,now=Date.now()) {
 if(!validScope(scope))return false;
 const at=Date.parse(post.publishedAt),age=Math.min(72,Math.max(1,Number(scope.maxAgeHours)||24))*3600000;
 if(!Number.isFinite(at)||at>now+60000||now-at>age||at<Date.parse(scope.startAt)||at>Date.parse(scope.endAt))return false;
 const groups=[...scope.participants,scope.event,scope.condition,...(scope.dates.length?[scope.dates]:[]),...(scope.location.length?[scope.location]:[])];
 return groups.every(group=>group.some(alias=>has(post.text,alias)));
}
export function originUrl(url) {
 try {const u=new URL(url);if(!['http:','https:'].includes(u.protocol))return null;u.hash='';for(const key of [...u.searchParams.keys()])if(/^(utm_|fbclid$|gclid$)/i.test(key))u.searchParams.delete(key);return u.href;}catch{return null;}
}
export function createSocialCache(config,{now=Date.now,maxPosts=500}={}) {
 const posts=new Map();let revision=0;
 const scopes=Object.entries(config.markets||{}).filter(([,scope])=>validScope(scope));
 function remove(key){if(posts.delete(key))revision++;}
 function clear(provider,author){for(const [key,post]of posts)if(post.provider===provider&&(!author||post.authorId===author))remove(key);}
 function put(post) {
  remove(post.key); // An edit that no longer matches also removes the previous claim.
  if(typeof post.text!=='string'||post.text.length>10000||!scopes.some(([,scope])=>matchesScope(post,scope,now())))return;
  post.version=createHash('sha256').update(JSON.stringify([post.text,post.publishedAt,post.originUrl])).digest('hex').slice(0,16);
  post.id=`SOC-${createHash('sha256').update(post.key).digest('hex').slice(0,12)}-${post.version}`;
  posts.set(post.key,post);revision++;
  for(const [key,value]of posts)if(now()-Date.parse(value.publishedAt)>72*3600000)remove(key);
  while(posts.size>Math.min(1000,maxPosts))remove(posts.keys().next().value);
 }
 function prune(){for(const [key,post] of posts)if(!scopes.some(([,scope])=>matchesScope(post,scope,now())))remove(key);}
 function select(event) {
  prune();
  const scope=config.markets?.[event.marketTicker];if(!scope||scope.question!==event.title||scope.settlementRules!==event.rules)return [];
  const seen=new Set();return [...posts.values()].filter(post=>matchesScope(post,scope,now())).sort((a,b)=>Date.parse(b.publishedAt)-Date.parse(a.publishedAt)).flatMap(post=>{
   const origin=post.originUrl||normalized(post.text.replace(/https?:\/\/\S+/g,''));if(seen.has(origin))return [];seen.add(origin);
   return [{...post,relevance:{marketTicker:event.marketTicker,participants:scope.participants,event:scope.event,dates:scope.dates,location:scope.location,condition:scope.condition}}];
  }).slice(0,6);
 }
 function evidence(post) {
  const uncertain=/\b(rumou?r|unconfirmed|allegedly|hearsay)\b/i.test(post.text),opinion=/\b(i think|i believe|in my opinion|my prediction)\b/i.test(post.text);
  return {id:post.id,provider:post.provider,postId:post.postId,author:{id:post.authorId,handle:post.authorHandle||null},title:post.text.slice(0,240),url:post.url,domain:new URL(post.url).hostname,description:'',content:post.text,date:post.publishedAt,publishedAt:post.publishedAt,retrievedAt:post.retrievedAt,observations:null,units:null,originUrl:post.originUrl||post.url,social:true,socialVersion:post.version,relevance:post.relevance,
   claimType:uncertain?'Unverified rumor':opinion?'Opinion':'Reported claim; not independently verified',access:'Social post text only; linked material was not retrieved by this connector.',limitations:['Account selection, verification badges and popularity do not establish credibility.','An attributed official statement requires corroboration; this post is not automatically classified as official.','Social claims cannot override settlement rules.']};
 }
 return {put,remove,clear,prune,select,evidence,get:id=>[...posts.values()].find(p=>p.id===id),get size(){return posts.size;},get revision(){return revision;}};
}
