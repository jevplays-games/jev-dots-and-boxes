import {sha256} from '../public/analytics.js';
export const first=(env,sql,...args)=>env.DB.prepare(sql).bind(...args).first();
export const all=async(env,sql,...args)=>(await env.DB.prepare(sql).bind(...args).all()).results;
export const run=(env,sql,...args)=>env.DB.prepare(sql).bind(...args).run();
export class HttpError extends Error { constructor(status,code,message=code){super(message);this.status=status;this.code=code;} }
export const fail=(status,code,message)=>{throw new HttpError(status,code,message);};
export const token=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),x=>x.toString(16).padStart(2,'0')).join('');
export const validToken=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
export const validId=x=>typeof x==='string'&&/^[\w-]{8,80}$/.test(x);
export const json=(data,status=200,headers={})=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers}});
export function localDevelopment(env){return env.DEV_MODE==='true'&&/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(env.APP_ORIGIN??'');}
export function cookieName(env){return localDevelopment(env)?'dots_session':'__Host-dots_session';}
export function cookie(env,value,maxAge=604800){return `${cookieName(env)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${localDevelopment(env)?'':'; Secure'}`;}
export function cookies(request){return Object.fromEntries((request.headers.get('cookie')??'').split(';').map(v=>v.trim().split('=')).filter(a=>a.length===2));}
export async function body(request,max=65536){
  if(!request.headers.get('content-type')?.toLowerCase().includes('application/json'))fail(415,'json_required');
  const text=await limitedText(request,max);try{const b=JSON.parse(text);if(!b||typeof b!=='object'||Array.isArray(b))throw Error();return b;}catch{fail(400,'invalid_json');}
}
export async function limitedText(request,max){
  if(Number(request.headers.get('content-length')??0)>max)fail(413,'body_too_large');
  if(!request.body)return '';const reader=request.body.getReader();let size=0;const chunks=[];
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>max){await reader.cancel();fail(413,'body_too_large');}chunks.push(value);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return new TextDecoder().decode(bytes);
}
export async function quota(env,key,limit,windowMs=3600000){
  const now=Date.now(),start=Math.floor(now/windowMs)*windowMs,bucket=await sha256(`${key}:${start}`);
  const row=await first(env,'INSERT INTO quotas(bucket,count,expires_at) VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET count=count+1 RETURNING count',bucket,start+windowMs);
  if(row.count>limit)fail(429,'rate_limited','Request limit reached. Try again after the current quota window.');
}
export async function operation(env,type,data){
  // Only explicit caller-provided fields: no raw URLs, headers, request bodies or tokens.
  await run(env,'INSERT INTO operational_events(id,utc,type,data_json) VALUES(?,?,?,?)',crypto.randomUUID(),new Date().toISOString(),type,JSON.stringify(data));
}
// Discord shows an Activity inside its own iframe. Only a page loaded with Discord's frame_id may be framed, and only by Discord.
export const ACTIVITY_FRAME_ANCESTORS='frame-ancestors https://discord.com https://ptb.discord.com https://canary.discord.com';
export function responseSecurity(response,url=null){
  const h=new Headers(response.headers);h.set('X-Content-Type-Options','nosniff');h.set('Referrer-Policy','no-referrer');h.set('X-Frame-Options','DENY');
  h.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  if(url&&!url.pathname.startsWith('/api/')&&url.searchParams.has('frame_id')){h.delete('X-Frame-Options');h.set('Content-Security-Policy',h.get('Content-Security-Policy').replace("frame-ancestors 'none'",ACTIVITY_FRAME_ANCESTORS));}
  h.set('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  return new Response(response.body,{status:response.status,headers:h});
}
export async function withTimeout(url,init={},timeout=5000,fetcher=fetch){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout);
  try{return await fetcher(url,{...init,signal:controller.signal});}finally{clearTimeout(timer);}
}
