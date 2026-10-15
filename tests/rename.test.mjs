import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {createInitialState,applyAction,exportReplay,replay,GAME_ID,LEGACY_GAME_ID,REPLAY_FORMAT} from '../public/games/box-score/rules.js';
import {prepareDecision,profileConfig} from '../src/jev.js';import {sha256} from '../public/analytics.js';
import {environment,Client} from './helpers.mjs';import worker from '../src/worker.js';
// Exported by the pre-rename build (jev-dots-and-boxes@1f8830f, game id 'dots-and-boxes'). Do not regenerate.
const preRename=JSON.parse(readFileSync(new URL('./fixtures/pre-rename-replay.json',import.meta.url),'utf8'));
const LEGACY='http://localhost:8787';
test('a replay exported before the Box Score rename still imports and verifies',()=>{assert.equal(preRename.game,'dots-and-boxes');assert.equal(preRename.format,'jev-arcade-replay-v1');const r=replay(preRename);assert.deepEqual(r.score,{human:3,jev:13});assert.equal(r.outcome,'loss');assert.equal(r.states.length,preRename.actions.length+1);});
test('new exports write the box-score id in the original replay format and round-trip',()=>{assert.equal(GAME_ID,'box-score');assert.equal(LEGACY_GAME_ID,'dots-and-boxes');let s=createInitialState({size:2});const events=[];for(const edgeId of [0,1,2,3,4]){s=applyAction(s,{edgeId}).state;events.push({type:'move_committed',data:{edgeId}});}const data=exportReplay(s,events);assert.equal(data.game,'box-score');assert.equal(data.format,REPLAY_FORMAT);assert.equal(replay(data).states.length,6);assert.equal(replay({...data,format:'jevplay-replay-v1'}).states.length,6);assert.throws(()=>replay({...data,game:'checkers'}),/Unsupported replay/);assert.throws(()=>replay({...data,format:'other-replay-v1'}),/Unsupported replay/);});
test('the model-facing Jev request and profile hashes are unchanged by the rename',async()=>{const p=await prepareDecision(createInitialState(),'easy','jev-1.13.0');assert.equal(p.request.state.game,'dots-and-boxes');assert.equal(p.requestHash,'58d3f2a34fb3b16bab7b845eba72f326de1ed44407f93ded294924afce5b907c');assert.equal(await sha256(profileConfig({},'normal')),'3f5f1380624569f0b61e954b6c260644aa96cc065bd32bde81fbf6783e1f6e2d');});
test('health reports the new game id',async()=>{const env=environment(),c=new Client(env);try{const {status,body}=await c.request('/api/health');assert.equal(status,200);assert.deepEqual(body,{ok:true,game:'box-score',version:'1.0.0'});}finally{env.DB.close();}});
test('the pre-rename hostname keeps working until cutover, with same-host origin checks',async()=>{const env=environment({LEGACY_APP_ORIGINS:LEGACY,DISCORD_CLIENT_ID:'111111',DISCORD_CLIENT_SECRET:'secret'});try{
  const call=async(origin,path,init={})=>worker.fetch(new Request(origin+path,init),env,{waitUntil:p=>p});
  assert.equal((await call('http://other.invalid','/api/health')).status,400);
  assert.equal((await call(LEGACY,'/api/health')).status,200);
  const session=await call(LEGACY,'/api/session'),cookie=session.headers.get('set-cookie').split(';')[0],{csrf}=await session.json();
  const create=origin=>call(LEGACY,'/api/matches',{method:'POST',headers:{cookie,origin,'x-csrf-token':csrf,'content-type':'application/json'},body:JSON.stringify({difficulty:'easy',mode:'local'})});
  assert.equal((await create(env.APP_ORIGIN)).status,403,'a mutation must come from the host it is sent to');
  assert.equal((await create(LEGACY)).status,201);
  const started=await call(LEGACY,'/api/auth/discord',{headers:{cookie}});assert.equal(started.status,302);
  assert.equal(new URL(started.headers.get('location')).searchParams.get('redirect_uri'),`${LEGACY}/api/auth/discord/callback`);
  const canonical=await call(env.APP_ORIGIN,'/api/auth/discord');assert.equal(new URL(canonical.headers.get('location')).searchParams.get('redirect_uri'),`${env.APP_ORIGIN}/api/auth/discord/callback`);
}finally{env.DB.close();}});
test('without LEGACY_APP_ORIGINS only the canonical origin is served',async()=>{const env=environment();try{assert.equal((await worker.fetch(new Request(LEGACY+'/api/health'),env,{waitUntil:p=>p})).status,400);}finally{env.DB.close();}});
