/** Shared analytics: summaries, lossless export, replay audit and safe CSV. */
import {createInitialState,applyAction,serialize,getScore,getOutcome} from './games/dots-and-boxes/rules.js';
export const EVENT_SCHEMA='dots-analytics-v1';
let CLOCK_DOMAIN; // created on first use: Workers forbid random values in module scope
export function canonical(value) {
  if(value===null||typeof value!=='object')return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  return '{'+Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
}
export async function sha256(value) {
  const bytes=new TextEncoder().encode(typeof value==='string'?value:canonical(value));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
}
export async function appendEvent(match,type,data={},requestId=null,now=Date.now()) {
  const last=match.events.at(-1);
  const e={schema:EVENT_SCHEMA,matchId:match.id,sequence:match.events.length+1,utc:new Date(now).toISOString(),elapsedMs:Math.max(0,now-match.createdAt),
    type,requestId,clock:{domainId:(CLOCK_DOMAIN??=crypto.randomUUID()),monotonicMs:performance.now()},previousHash:last?.hash??'0'.repeat(64),data};
  e.hash=await sha256(e);match.events.push(e);return e;
}
export function statistics(values) {
  const a=values.filter(Number.isFinite).sort((x,y)=>x-y);
  if(!a.length)return {n:0,min:null,max:null,mean:null,p50:null,p95:null,p99:null};
  const q=p=>{const x=(a.length-1)*p,i=Math.floor(x);return a[i]+(a[Math.ceil(x)]-a[i])*(x-i);};
  return {n:a.length,min:a[0],max:a.at(-1),mean:a.reduce((x,y)=>x+y,0)/a.length,p50:q(.5),p95:q(.95),p99:q(.99)};
}
export function distributionMetrics(probabilities) {
  if(!probabilities)return {entropyBits:null,normalizedEntropy:null,topGap:null};
  const p=Object.values(probabilities).sort((a,b)=>b-a),h=Math.max(0,-p.reduce((n,x)=>n+(x>0?x*Math.log2(x):0),0));
  return {entropyBits:h,normalizedEntropy:p.length>1?h/Math.log2(p.length):0,topGap:p[0]-(p[1]??0)};
}
export function summarize(match) {
  const events=match.events??[],moves=events.filter(e=>e.type==='move_committed').map(e=>e.data),decisions=events.filter(e=>e.type==='decision_completed').map(e=>e.data),
    attempts=events.filter(e=>e.type==='provider_attempt').map(e=>e.data),sources={};
  decisions.forEach(d=>sources[d.source]=(sources[d.source]??0)+1);
  const chains={human:0,jev:0};let run=0,prev=null;
  for(const m of moves){run=m.player===prev?run+1:1;prev=m.player;const k=m.player===0?'human':'jev';chains[k]=Math.max(chains[k],run);}
  const players=[0,1].map(player=>{const rows=moves.filter(m=>m.player===player);return {player,moves:rows.length,
    scoringMoves:rows.filter(m=>m.capturedBoxes.length).length,boxes:rows.reduce((n,m)=>n+m.capturedBoxes.length,0),doubleCaptures:rows.filter(m=>m.capturedBoxes.length===2).length,
    newThirdSides:rows.reduce((n,m)=>n+(m.features?.newThirdSides??0),0),
    declinedImmediateCapture:rows.filter(m=>m.captureAvailable&&!m.capturedBoxes.length).length,
    exactRegret:statistics(rows.map(m=>m.exactRegret)),serverObservedTurnMs:statistics(rows.map(m=>m.turnElapsedMs))};});
  const knownUsage=attempts.filter(a=>a.usage),knownCost=attempts.filter(a=>Number.isFinite(a.estimatedCostUsd));
  return {schema:EVENT_SCHEMA,matchId:match.id,mode:match.mode,difficulty:match.difficulty,poolId:match.poolId,
    status:match.status,outcome:match.outcome??getOutcome(match.state),score:getScore(match.state),verified:!!match.verified,rankedEligible:!!match.ranked&&!!match.verified,
    eventCount:events.length,moveCount:moves.length,decisionCount:decisions.length,sources,players,longestSamePlayerRun:chains,
    latencyMs:statistics(decisions.map(d=>d.totalMs)),providerLatencyMs:statistics(attempts.map(a=>a.latencyMs)),featureLatencyMs:statistics(decisions.map(d=>d.featureMs)),
    confidence:statistics(decisions.map(d=>d.confidence)),entropyBits:statistics(decisions.map(d=>d.entropyBits)),candidateCount:statistics(decisions.map(d=>d.candidateCount)),
    searchNodes:decisions.reduce((n,d)=>n+(d.searchNodes??0),0),searchCacheHits:decisions.reduce((n,d)=>n+(d.searchCacheHits??0),0),
    exactDecisions:decisions.filter(d=>d.allCandidatesExact).length,
    providerAttempts:attempts.length,providerFailures:attempts.filter(a=>!a.ok).length,retries:attempts.filter(a=>a.attempt>1).length,
    fallbackDecisions:decisions.filter(d=>d.source==='fallback').length,illegalOutputFailures:attempts.filter(a=>a.errorCode==='invalid_response').length,
    knownInputTokens:knownUsage.reduce((n,a)=>n+(a.usage.input_tokens??0),0),knownOutputTokens:knownUsage.reduce((n,a)=>n+(a.usage.output_tokens??0),0),
    unknownUsageAttempts:attempts.length-knownUsage.length,
    estimatedCostUsd:knownCost.length?knownCost.reduce((n,a)=>n+a.estimatedCostUsd,0):null,costUnknownAttempts:attempts.length-knownCost.length,
    durationMs:(match.finishedAt??Date.now())-match.createdAt,headHash:events.at(-1)?.hash??null,
    caveats:['Model confidence is not win probability.','Server turn elapsed time includes network delay and idle time.','Regret is null unless every candidate is solved exactly.','Usage and cost exclude unreported provider consumption.']};
}
export async function auditMatch(match,{verifyDecisions=true}={}) {
  let previous='0'.repeat(64),state=createInitialState({size:match.state.size,firstPlayer:match.state.firstPlayer});const errors=[],decisions=new Map(),prepared=new Map();
  for(let i=0;i<(match.events??[]).length;i++){
    const e=match.events[i],{hash,...body}=e;
    if(e.schema!==EVENT_SCHEMA||e.matchId!==match.id||e.sequence!==i+1||e.previousHash!==previous||hash!==await sha256(body))errors.push(`Event ${i+1}: hash/sequence mismatch`);
    previous=hash;
    if(e.type==='decision_prepared'){
      prepared.set(e.data.decisionId,e.data);
      if(e.data.stateHash!==await sha256(serialize(state)))errors.push(`Event ${i+1}: decision state mismatch`);
      if(e.data.request&&e.data.requestHash!==await sha256(e.data.request))errors.push(`Event ${i+1}: request hash mismatch`);
    }
    if(e.type==='decision_completed'){
      const d=e.data,p=prepared.get(d.decisionId);decisions.set(d.decisionId,d);
      if(d.source==='jev'){
        const a=d.response?.answers?.move,ids=p?.admissibleIds??[],probs=a?.probabilities??{},values=Object.values(probs);
        const expected=[...ids].map(String).sort(),actual=Object.keys(probs).sort();
        if(!p||d.requestHash!==p.requestHash||d.model!==match.profile?.model||d.response?.model!==d.model||a?.type!=='choice'||!ids.includes(d.edgeId)||canonical(expected)!==canonical(actual)||values.some(v=>!Number.isFinite(v)||v<0||v>1)||Math.abs(values.reduce((n,v)=>n+v,0)-1)>0.001||!Number.isFinite(probs[String(d.edgeId)])||Math.abs(probs[String(d.edgeId)]-Math.max(...values))>1e-9)
          errors.push(`Event ${i+1}: invalid provider evidence`);
      }
      if(d.source==='forced'&&p?.candidates.length!==1)errors.push(`Event ${i+1}: invalid forced action`);
      if(d.source==='solver'&&(!p?.candidates.every(c=>c.search?.exact)||!p.admissibleIds.includes(d.edgeId)))errors.push(`Event ${i+1}: invalid solver evidence`);
    }
    if(e.type==='move_committed'){
      try{
        const d=e.data;
        if(d.player!==state.toMove||d.preStateHash!==await sha256(serialize(state)))throw Error('pre-state/actor mismatch');
        if(verifyDecisions&&d.player===1){const decision=decisions.get(d.decisionId);if(!decision||decision.edgeId!==d.edgeId||decision.source!==d.source)throw Error('missing/mismatched decision provenance');}
        const applied=applyAction(state,{edgeId:d.edgeId});state=applied.state;
        if(canonical(applied.event.capturedBoxes)!==canonical(d.capturedBoxes)||d.postStateHash!==await sha256(serialize(state)))throw Error('capture/post-state mismatch');
      }catch(error){errors.push(`Event ${i+1}: ${error.message}`);}
    }
  }
  if(serialize(state)!==serialize(match.state))errors.push('Final state mismatch');
  if(match.status==='completed'&&getOutcome(state)!==match.outcome)errors.push('Final outcome mismatch');
  if(match.ranked&&match.events.some(e=>e.type==='decision_completed'&&['fallback','local'].includes(e.data.source)))errors.push('Non-JEV decision in ranked match');
  return {ok:errors.length===0,errors,events:match.events.length,headHash:previous,state,score:getScore(state),outcome:getOutcome(state)};
}
export function csv(rows) {
  if(!rows.length)return '';
  const headers=[...new Set(rows.flatMap(r=>Object.keys(r)))];
  const cell=v=>{let s=v===null||v===undefined?'':typeof v==='object'?JSON.stringify(v):String(v);if(/^[=+@\-\t\r]/.test(s)&&typeof v!=='number')s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
  return [headers.map(cell).join(','),...rows.map(r=>headers.map(k=>cell(r[k])).join(','))].join('\r\n')+'\r\n';
}
export function exportTables(match) {
  const moves=[],decisions=[],candidates=[],attempts=[],events=[];
  const byId=new Map(match.events.filter(e=>e.type==='decision_completed').map(e=>[e.data.decisionId,e.data]));
  for(const e of match.events){events.push({matchId:match.id,sequence:e.sequence,utc:e.utc,type:e.type,requestId:e.requestId,hash:e.hash,data:e.data});
    if(e.type==='move_committed')moves.push({matchId:match.id,sequence:e.sequence,utc:e.utc,...e.data});
    if(e.type==='decision_prepared')for(const c of e.data.candidates??[]){const d=byId.get(e.data.decisionId);candidates.push({matchId:match.id,decisionId:e.data.decisionId,...c,selected:d?.edgeId===c.edgeId,probability:d?.probabilities?.[String(c.edgeId)]??null,modelConfidence:d?.confidence??null,source:d?.source??null});}
    if(e.type==='decision_completed')decisions.push({matchId:match.id,...e.data});
    if(e.type==='provider_attempt')attempts.push({matchId:match.id,...e.data});
  }
  return {moves,decisions,candidates,attempts,events};
}
