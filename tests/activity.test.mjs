import test from 'node:test';import assert from 'node:assert/strict';
import {environment} from './helpers.mjs';import worker from '../src/worker.js';import {ACTIVITY_FRAME_ANCESTORS} from '../src/common.js';
const APP='123456789012345678',ACTIVITY=`https://${APP}.discordsays.com`;
function discordFetch(calls=[]){
  return async(url,options)=>{
    calls.push({url:String(url),body:options?.body?String(options.body):null});
    if(String(url).endsWith('/oauth2/token'))return new Response(JSON.stringify({access_token:'fixture-access'}),{headers:{'Content-Type':'application/json'}});
    if(String(url).endsWith('/users/@me'))return new Response(JSON.stringify({id:'223344556677889900',username:'player',global_name:'Player One',avatar:null}),{headers:{'Content-Type':'application/json'}});
    throw Error(`unexpected fetch ${url}`);
  };
}
const setup=(t,extra={})=>{const env=environment({DISCORD_CLIENT_ID:APP,DISCORD_CLIENT_SECRET:'fixture-secret',FETCH:discordFetch(),...extra});t.after(()=>env.DB.close());return env;};
const send=(env,path,{method='GET',origin,body,headers={}}={})=>worker.fetch(new Request(env.APP_ORIGIN+path,{method,headers:{...(origin?{origin}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{}),...headers},...(body!==undefined?{body:JSON.stringify(body)}:{})}),env,{waitUntil:p=>p.catch(()=>{})});
const post=(env,path,o={})=>send(env,path,{method:'POST',origin:ACTIVITY,body:{},...o});
const bearerSession=async env=>(await post(env,'/api/activity/session',{body:{code:'c'}})).json();

test('activity config exposes only the public client id and needs Discord configured',async t=>{
  const r=await send(setup(t),'/api/activity/config');assert.equal(r.status,200);assert.deepEqual(await r.json(),{clientId:APP});
  assert.equal((await send(setup(t,{DISCORD_CLIENT_ID:undefined,DISCORD_CLIENT_SECRET:undefined}),'/api/activity/config')).status,503);
});
test('an SDK code becomes a bearer session: exchanged without a redirect uri, token is not stored in clear',async t=>{
  const calls=[],env=setup(t,{FETCH:discordFetch(calls)}),r=await post(env,'/api/activity/session',{body:{code:'sdk-code'}});assert.equal(r.status,200);
  const s=await r.json();assert.match(s.token,/^[a-f0-9]{64}$/);assert.match(s.csrf,/^[a-f0-9]{64}$/);assert.equal(s.accessToken,'fixture-access');assert.equal(s.user.display_name,'Player One');
  const exchange=new URLSearchParams(calls[0].body);assert.equal(exchange.get('grant_type'),'authorization_code');assert.equal(exchange.get('code'),'sdk-code');assert.equal(exchange.has('redirect_uri'),false);
  assert.equal(r.headers.get('set-cookie'),null,'no cookie is set inside an Activity');
  assert.equal(await env.DB.prepare('SELECT 1 AS x FROM sessions WHERE token_hash=?').bind(s.token).first(),null,'the raw token must not be stored');
  assert.equal(JSON.stringify(await env.DB.prepare('SELECT * FROM sessions').all()).includes('fixture-access'),false,'the Discord access token must not be stored');
});
test('the bearer session works for reads and for mutations from the activity origin',async t=>{
  const env=setup(t),s=await bearerSession(env),auth={authorization:`Bearer ${s.token}`};
  const me=await (await send(env,'/api/session',{headers:auth})).json();assert.equal(me.user.display_name,'Player One');assert.equal(me.csrf,s.csrf);
  const created=await post(env,'/api/matches',{headers:{...auth,'x-csrf-token':s.csrf},body:{difficulty:'easy',mode:'local'}});assert.equal(created.status,201);
  const out=await post(env,'/api/logout',{headers:{...auth,'x-csrf-token':s.csrf}});assert.equal(out.status,200);
  assert.equal((await (await send(env,'/api/session',{headers:auth})).json()).user,null,'logout revoked the bearer session');
});
test('the activity origin is accepted only together with a bearer session',async t=>{
  const env=setup(t),s=await bearerSession(env),auth={authorization:`Bearer ${s.token}`,'x-csrf-token':s.csrf};
  const fresh=await send(env,'/api/session'),cookie=fresh.headers.get('set-cookie').split(';')[0],me=await fresh.json();
  assert.equal((await post(env,'/api/logout',{headers:{cookie,'x-csrf-token':me.csrf}})).status,403,'a cookie session must not be usable from the discordsays origin');
  assert.equal((await post(env,'/api/logout',{origin:'https://evil.example',headers:auth})).status,403);
  assert.equal((await post(env,'/api/logout',{origin:'https://999999999999999999.discordsays.com',headers:auth})).status,403,"another application's discordsays origin is not ours");
  assert.equal((await post(env,'/api/logout',{headers:{authorization:auth.authorization}})).status,403,'csrf is still required');
  assert.equal((await post(env,'/api/logout',{origin:ACTIVITY,headers:{'x-csrf-token':me.csrf}})).status,403,'no session at all from the activity origin');
  assert.equal((await post(env,'/api/logout',{headers:auth})).status,200);
});
test('session creation rejects foreign origins, missing codes and Discord failures',async t=>{
  const env=setup(t);
  assert.equal((await post(env,'/api/activity/session',{origin:'https://evil.example',body:{code:'c'}})).status,403);
  assert.equal((await post(env,'/api/activity/session',{origin:undefined,body:{code:'c'}})).status,403);
  assert.equal((await post(env,'/api/activity/session',{body:{}})).status,400);
  assert.equal((await post(env,'/api/activity/session',{body:{code:'x'.repeat(3000)}})).status,400);
  assert.equal((await send(env,'/api/session',{headers:{authorization:'Bearer nothex'}})).status,200,'a malformed bearer is ignored and a fresh anonymous session is issued');
  assert.equal((await post(setup(t,{FETCH:async()=>new Response('no',{status:400})}),'/api/activity/session',{body:{code:'c'}})).status,502);
});
test('only a page loaded with frame_id may be framed, and only by Discord',async t=>{
  const env=setup(t),plain=await send(env,'/'),framed=await send(env,'/?frame_id=1&instance_id=2&platform=desktop');
  assert.equal(plain.headers.get('x-frame-options'),'DENY');assert.match(plain.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  assert.equal(framed.headers.get('x-frame-options'),null);const csp=framed.headers.get('content-security-policy');assert.ok(csp.includes(ACTIVITY_FRAME_ANCESTORS));assert.ok(!csp.includes("frame-ancestors 'none'"));
  assert.match(csp,/script-src 'self'/);assert.match(csp,/connect-src 'self'/);
  const api=await send(env,'/api/health?frame_id=1');assert.equal(api.headers.get('x-frame-options'),'DENY','API responses are never frameable');assert.match(api.headers.get('content-security-policy'),/frame-ancestors 'none'/);
});
