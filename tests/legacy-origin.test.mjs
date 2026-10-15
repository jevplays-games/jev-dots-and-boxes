import test from 'node:test';import assert from 'node:assert/strict';
import {environment} from './helpers.mjs';import worker from '../src/worker.js';import {appOrigins} from '../src/common.js';
// Orchestrator rule D9: hostile or malformed LEGACY_APP_ORIGINS entries are skipped with one structured warning, never
// admitted and never a 5xx. Every request goes through the real Worker entry point.
const NEW='https://box-score.jevplay.games',OLD='https://dots-and-boxes.jevplay.games';
const HOSTILE=['https://user:pw@evil.example',`https://evil.example#@${new URL(OLD).host}`,'https://evil.example/path','https://evil.example?q=1','https://*.jevplay.games'];
const status=async(env,origin)=>(await worker.fetch(new Request(origin+'/api/health'),env,{waitUntil:p=>p})).status;
async function quietly(run){const warnings=[],warn=console.warn;console.warn=message=>warnings.push(message);try{await run();}finally{console.warn=warn;}return warnings.map(w=>JSON.parse(w));}
for(const entry of HOSTILE)test(`D9: legacy entry ${entry} admits no other host and both real hosts stay served`,async()=>{
  const env=environment({APP_ORIGIN:NEW,DEV_MODE:'false',LEGACY_APP_ORIGINS:`${entry},${OLD}/`});
  try{
    const warnings=await quietly(async()=>{
      assert.deepEqual(appOrigins(env),[NEW,OLD]);
      assert.equal(await status(env,'https://evil.example'),400);
      if(entry.includes('*'))assert.equal(await status(env,entry),400,'a literal wildcard host must not be served');
      assert.equal(await status(env,NEW),200);
      assert.equal(await status(env,OLD),200,'one trailing "/" on a real legacy origin is tolerated');
    });
    assert.deepEqual(warnings,[{event:'legacy_origin_skipped',variable:'LEGACY_APP_ORIGINS',entry,reason:'not a bare https origin'}]);
  }finally{env.DB.close();}
});
test('D9: only bare origins are admitted; http only for a loopback host in local development',async()=>{
  const warnings=await quietly(async()=>{
    assert.deepEqual(appOrigins({APP_ORIGIN:NEW,LEGACY_APP_ORIGINS:` ${OLD} , ,https://dots-and-boxes.jevplay.games:8443`}),[NEW,OLD,'https://dots-and-boxes.jevplay.games:8443']);
    assert.deepEqual(appOrigins({APP_ORIGIN:NEW,LEGACY_APP_ORIGINS:'http://dots-and-boxes.jevplay.games,http://localhost:8787,ftp://dots-and-boxes.jevplay.games,dots-and-boxes.jevplay.games,https://dots-and-boxes.jevplay.games//'}),[NEW]);
    assert.deepEqual(appOrigins({APP_ORIGIN:'http://127.0.0.1:8787',DEV_MODE:'true',LEGACY_APP_ORIGINS:'http://localhost:8787,http://dots-and-boxes.jevplay.games'}),['http://127.0.0.1:8787','http://localhost:8787']);
  });
  assert.deepEqual(warnings.map(w=>w.entry).sort(),['dots-and-boxes.jevplay.games','ftp://dots-and-boxes.jevplay.games','http://dots-and-boxes.jevplay.games','http://localhost:8787','https://dots-and-boxes.jevplay.games//']);
});
test('D9: a list of only malformed entries leaves the canonical host working and every other host rejected',async()=>{
  const env=environment({APP_ORIGIN:NEW,DEV_MODE:'false',LEGACY_APP_ORIGINS:'::::,%%%,null,*'});
  try{await quietly(async()=>{for(const [origin,expected] of [[NEW,200],[OLD,400],['https://evil.example',400]])assert.equal(await status(env,origin),expected,origin);});}finally{env.DB.close();}
});
