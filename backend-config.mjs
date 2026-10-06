import {existsSync,readFileSync} from 'node:fs';
const envFile=new URL('./.env',import.meta.url);
if(existsSync(envFile)) process.loadEnvFile(envFile);
export function readMappings() {
  const file=new URL('./data-source-mappings.local.json',import.meta.url);
  if(!existsSync(file)) return {};
  try {const value=JSON.parse(readFileSync(file,'utf8')); if(!value || Array.isArray(value) || typeof value!=='object') throw Error(); return value;}
  catch {throw new Error('Invalid data-source-mappings.local.json; expected an object keyed by market ticker.');}
}

export function redactSecrets(value) {
  return ['GNEWS_API_KEY','FRED_API_KEY','BLS_API_KEY','X_BEARER_TOKEN'].reduce((text,name)=>process.env[name]?text.split(process.env[name]).join('[REDACTED]'):text,String(value));
}
