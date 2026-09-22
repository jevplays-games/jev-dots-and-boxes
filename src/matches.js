import {createInitialState,applyAction,serialize,getScore,getOutcome,isTerminal,exportReplay} from '../public/games/dots-and-boxes/rules.js';
import {analyzeCandidates,exactRegret,tacticalSnapshot,PROFILES} from '../public/games/dots-and-boxes/analysis.js';
import {appendEvent,sha256,auditMatch,summarize,exportTables,csv} from '../public/analytics.js';
import {prepareDecision,evaluatePrepared,profileConfig} from './jev.js';
import {first,all,run,fail,json,validId,quota} from './common.js';
import {launchContext} from './auth.js';
export async function poolId(env,difficulty){return sha256(profileConfig(env,difficulty));}
export async function loadMatch(env,id,s=null){
  const row=await first(env,'SELECT * FROM matches WHERE id=?',id);
  if(!row||s&&row.owner_key!==s.ownerKey)fail(404,'match_not_found');return {row,match:JSON.parse(row.record_json)};
}
export async function saveMatch(env,m,version){
  const result=await run(env,'UPDATE matches SET record_json=?,version=version+1,status=?,ranked=?,verified=?,outcome=? WHERE id=? AND version=?',JSON.stringify(m),m.status,Number(m.ranked),Number(m.verified),m.outcome??null,m.id,version);
  if(result.meta.changes!==1)fail(409,'revision_conflict','The match changed. Refresh the authoritative state.');
}
export function snapshot(m){
  const lastDecision=m.events.findLast(e=>e.type==='decision_completed')?.data??null;
  return {id:m.id,state:m.state,revision:m.revision,status:m.status,mode:m.mode,difficulty:m.difficulty,ranked:m.ranked,requestedRanked:m.requestedRanked,
    verified:m.verified,outcome:m.outcome,createdAt:m.createdAt,finishedAt:m.finishedAt??null,expiresAt:m.expiresAt,poolId:m.poolId,profile:m.profile,
    lastDecision,eventCount:m.events.length,pending:!!m.pending,summary:summarize(m),notice:m.notice??null};
}
export async function settle(m,termination){
  m.status=termination==='completed'?'completed':termination==='forfeit'?'forfeit':'void';m.finishedAt=Date.now();m.pending=null;
  m.outcome=termination==='completed'?getOutcome(m.state):termination==='forfeit'?'loss':null;
  await appendEvent(m,'match_settled',{termination,outcome:m.outcome,score:getScore(m.state)});
  const report=await auditMatch(m);m.verified=report.ok&&termination!=='void';
  await appendEvent(m,'verification_completed',{ok:report.ok,errors:report.errors,rankedEligible:m.ranked&&m.verified,headHash:report.headHash});
  if(!report.ok){m.ranked=false;m.notice='Verification failed. This result is not ranked.';}
}
export async function expireMatches(env,ownerKey=null){
  const rows=await all(env,`SELECT id,version,record_json FROM matches WHERE status='active' AND expires_at<=? ${ownerKey?'AND owner_key=?':''} LIMIT 100`,Date.now(),...(ownerKey?[ownerKey]:[]));
  for(const row of rows){const m=JSON.parse(row.record_json);await appendEvent(m,'match_expired',{});await settle(m,'forfeit');try{await saveMatch(env,m,row.version);}catch(e){if(e.status!==409)throw e;}}
}
export async function createMatch(env,s,b){
  await expireMatches(env,s.ownerKey);
  if(!PROFILES[b.difficulty??'normal'])fail(400,'invalid_difficulty');
  if(b.mode!==undefined&&!['jev','local'].includes(b.mode))fail(400,'invalid_mode');
  if(b.ranked!==undefined&&typeof b.ranked!=='boolean')fail(400,'invalid_ranked_flag');
  if(b.ranked&&!s.user_id)fail(401,'discord_required');
  const mode=b.mode??(env.TYPESAFE_API_KEY?'jev':'local'),difficulty=b.difficulty??'normal',ranked=!!b.ranked;
  if(mode==='jev'&&!env.TYPESAFE_API_KEY)fail(503,'jev_not_configured','Add a TypeSafe API key or choose Local practice.');
  if(ranked&&(mode!=='jev'||!/^jev-\d+\.\d+\.\d+$/.test(env.JEV_MODEL??'jev-1.13.0')))fail(400,'ranked_requires_pinned_jev');
  const active=await first(env,"SELECT id FROM matches WHERE owner_key=? AND status='active'",s.ownerKey);
  if(active)fail(409,'active_match_exists',`Resume or concede the active match: ${active.id}`);
  await quota(env,`create:${s.ownerKey}`,s.user_id?100:30,86400000);
  const profile=profileConfig(env,difficulty),pool=await poolId(env,difficulty);
  const sequence=await first(env,'SELECT COALESCE(MAX(attempt_no),-1)+1 AS next FROM matches WHERE owner_key=? AND pool_id=? AND ranked=?',s.ownerKey,pool,Number(ranked));
  const attempt=sequence.next,firstPlayer=ranked?attempt%2:b.firstPlayer===1?1:0,now=Date.now();
  let context=null,launchHash=null;
  if(s.pending_launch_hash&&s.user_id){
    context=await launchContext(env,s.pending_launch_hash,s.user_id);launchHash=context.launchHash;
    if(await first(env,'SELECT id FROM matches WHERE launch_hash=?',launchHash))fail(409,'launch_used','Invoke /play again for a new community match.');
  }
  const m={id:crypto.randomUUID(),format:'dots-match-v1',state:createInitialState({size:4,firstPlayer}),revision:0,events:[],profile,poolId:pool,
    difficulty,mode,ranked,requestedRanked:ranked,verified:false,status:'active',outcome:null,pending:null,createdAt:now,turnStartedAt:now,expiresAt:now+86400000,
    manifest:{eventSchema:'dots-analytics-v1',sourceRevision:env.SOURCE_REVISION??'unversioned-local',runtime:'web-standard',deployment:env.DEPLOYMENT_ID??'local',analyticsVersion:'v1',startingPlayer:firstPlayer,profile,providerEndpoint:'https://api.typesafe.ai/v1/systemone',costRates:{inputUsdPerMillion:env.INPUT_USD_PER_MILLION??null,outputUsdPerMillion:env.OUTPUT_USD_PER_MILLION??null}}};
  await appendEvent(m,'match_created',{mode,ranked,difficulty,poolId:pool,firstPlayer,profile,initialStateHash:await sha256(serialize(m.state))});
  try{
    await run(env,'INSERT INTO matches(id,owner_key,user_id,guild_id,channel_id,launch_hash,pool_id,season_id,attempt_no,first_player,status,ranked,verified,outcome,created_at,expires_at,version,record_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      m.id,s.ownerKey,s.user_id??null,context?.guildId??null,context?.channelId??null,launchHash,pool,new Date(now).toISOString().slice(0,7),attempt,firstPlayer,'active',Number(ranked),0,null,now,m.expiresAt,0,JSON.stringify(m));
  }catch(error){if(/unique|constraint/i.test(error.message))fail(409,'match_creation_conflict');throw error;}
  if(launchHash)await run(env,'UPDATE sessions SET pending_launch_hash=NULL WHERE token_hash=? AND pending_launch_hash=?',s.token_hash,launchHash);
  return json(snapshot(m),201);
}
async function commitMove(m,edgeId,source,requestId,decisionId=null,candidates=null){
  const start=performance.now(),before=m.state,features=candidates??analyzeCandidates(before,'easy'),chosen=features.find(c=>c.edgeId===edgeId);
  const preStateHash=await sha256(serialize(before)),transition=applyAction(before,{edgeId});m.state=transition.state;m.revision++;
  const now=Date.now();
  await appendEvent(m,'move_committed',{...transition.event,ply:m.state.ply,source,decisionId,preStateHash,postStateHash:await sha256(serialize(m.state)),score:getScore(m.state),
    features:chosen?{capturesNow:chosen.capturesNow,newThirdSides:chosen.newThirdSides,opponentImmediateCapture:chosen.opponentImmediateCapture,safeMovesAfter:chosen.safeMovesAfter}:null,
    captureAvailable:features.some(c=>c.capturesNow>0),exactRegret:exactRegret(features,edgeId,before.toMove),tactics:tacticalSnapshot(m.state),
    turnElapsedMs:now-m.turnStartedAt,commitComputeMs:performance.now()-start},requestId,now);
  m.turnStartedAt=now;
  if(isTerminal(m.state))await settle(m,'completed');
}
export async function stepMatch(env,s,id,b){
  if(!validId(b.requestId)||!Number.isInteger(b.expectedRevision))fail(400,'invalid_request_identity');
  let {row,match:m}=await loadMatch(env,id,s);
  const old=m.events.find(e=>e.requestId===b.requestId&&['move_committed','player_resigned'].includes(e.type));
  if(old){if(old.type==='move_committed'&&(b.operation==='human_move'?old.data.player!==0||old.data.edgeId!==b.edgeId: b.operation!=='jev_advance'||old.data.player!==1))fail(409,'request_id_reused');return json(snapshot(m));}
  if(m.expiresAt<=Date.now()&&m.status==='active'){await settle(m,'forfeit');await saveMatch(env,m,row.version);return json(snapshot(m));}
  if(m.status!=='active')fail(409,'match_not_active');
  if(m.revision!==b.expectedRevision)fail(409,'stale_revision');
  if(m.pending){
    if(m.pending.expiresAt>Date.now())return json({pending:true,...snapshot(m)},202,{'Retry-After':'1'});
    await appendEvent(m,'decision_lease_expired',{decisionId:m.pending.id,billingUnknown:true});
    m.ranked=false;m.mode='local';m.pending=null;m.notice='An unfinished provider decision could not be recovered. Ranked eligibility was voided; continuation is local practice.';
    await saveMatch(env,m,row.version);row.version++;
  }
  if(b.operation==='resign'){
    await appendEvent(m,'player_resigned',{},b.requestId);await settle(m,'forfeit');await saveMatch(env,m,row.version);return json(snapshot(m));
  }
  if(b.operation==='human_move'){
    if(m.state.toMove!==0)fail(409,'not_human_turn');
    if(!Number.isInteger(b.edgeId)||b.edgeId<0||b.edgeId>=m.state.edges.length||m.state.edges[b.edgeId]!==null)fail(400,'illegal_move');
    await commitMove(m,b.edgeId,'human',b.requestId);await saveMatch(env,m,row.version);return json(snapshot(m));
  }
  if(b.operation!=='jev_advance')fail(400,'invalid_operation');
  if(m.state.toMove!==1)fail(409,'not_jev_turn');
  if(m.poolId!==await poolId(env,m.difficulty))fail(409,'profile_changed','The opponent profile changed; finish this match with its original deployment or concede it.');
  const prepared=await prepareDecision(m.state,m.difficulty,m.profile.model);
  m.pending={id:prepared.decisionId,requestId:b.requestId,expiresAt:Date.now()+30000};
  await appendEvent(m,'decision_prepared',prepared,b.requestId);await saveMatch(env,m,row.version);
  const decision=await evaluatePrepared(prepared,m.state,m.mode,env);
  ({row,match:m}=await loadMatch(env,id,s));
  if(m.pending?.id!==prepared.decisionId||m.revision!==b.expectedRevision)fail(409,'stale_decision');
  for(const attempt of decision.attempts)await appendEvent(m,'provider_attempt',attempt,b.requestId);
  const {attempts,...evidence}=decision;await appendEvent(m,'decision_completed',evidence,b.requestId);
  if(decision.source==='fallback'){
    m.ranked=false;m.mode='local';m.notice=`JEV was unavailable (${decision.failure}). Continued against the local opponent; this match is not ranked.`;
    await appendEvent(m,'ranked_eligibility_voided',{reason:decision.failure,continuation:'local'});
  }
  m.pending=null;await commitMove(m,decision.edgeId,decision.source,b.requestId,decision.decisionId,prepared.candidates);await saveMatch(env,m,row.version);
  return json(snapshot(m));
}
export async function matchExport(env,s,id,format){
  const {match:m}=await loadMatch(env,id,s);
  if(format==='replay')return json(exportReplay(m.state,m.events,{difficulty:m.difficulty,model:m.profile.model,profileHash:m.poolId}));
  if(format==='summary')return json(summarize(m));
  if(format==='audit')return json(await auditMatch(m));
  if(format==='jsonl')return new Response(m.events.map(e=>JSON.stringify(e)).join('\n')+'\n',{headers:{'Content-Type':'application/x-ndjson','Cache-Control':'no-store'}});
  if(['moves','decisions','candidates','attempts','events'].includes(format))return new Response(csv(exportTables(m)[format]),{headers:{'Content-Type':'text/csv; charset=utf-8','Cache-Control':'no-store'}});
  if(format!=='json')fail(400,'invalid_export_format');return json(m);
}
