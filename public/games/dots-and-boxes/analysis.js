/** Versioned, deterministic feature extraction and turn-aware bounded minimax. */
import {geometry,getLegalActions,applyAction,getScore,edgeLabel} from './rules.js';
export const ANALYSIS_VERSION='analysis-v1';
export const PROFILES=Object.freeze({
  easy:Object.freeze({depth:0,nodes:0,exactThreshold:0}),
  normal:Object.freeze({depth:2,nodes:2000,exactThreshold:0}),
  hard:Object.freeze({depth:4,nodes:10000,exactThreshold:0}),
  jev:Object.freeze({depth:6,nodes:40000,exactThreshold:10})
});
export function sideCounts(s) { return geometry(s.size).boxes.map(b=>b.edges.reduce((n,e)=>n+Number(s.edges[e]!==null),0)); }
export function components(s) {
  const g=geometry(s.size), seen=new Set(), result=[];
  for (const box of g.boxes) {
    if (s.boxes[box.id]!==null||seen.has(box.id)) continue;
    const todo=[box.id], ids=[]; let ports=0, allDegreeTwo=true;
    seen.add(box.id);
    while(todo.length) {
      const id=todo.pop(); ids.push(id);
      const open=g.boxes[id].edges.filter(e=>s.edges[e]===null);
      if(open.length!==2) allDegreeTwo=false;
      for(const e of open) {
        if(g.edges[e].boxes.length===1) ports++;
        for(const nb of g.edges[e].boxes) if(nb!==id&&!seen.has(nb)&&s.boxes[nb]===null){seen.add(nb);todo.push(nb);}
      }
    }
    result.push({boxes:ids.sort((a,b)=>a-b),length:ids.length,exteriorPorts:ports,type:allDegreeTwo?(ports===0?'loop':ports===2?'chain':'unclassified'):'unclassified'});
  }
  return result;
}
function immediate(s,id,counts=sideCounts(s)) {
  const boxIds=geometry(s.size).edges[id].boxes;
  return {capturesNow:boxIds.filter(b=>counts[b]===3).length,newThirdSides:boxIds.filter(b=>counts[b]===2).length};
}
export function heuristicAction(s) {
  const counts=sideCounts(s), moves=getLegalActions(s).map(a=>({...a,...immediate(s,a.edgeId,counts)}));
  moves.sort((a,b)=>b.capturesNow-a.capturesNow||a.newThirdSides-b.newThirdSides||a.edgeId-b.edgeId);
  if (!moves.length) throw new Error('No legal move.'); return {edgeId:moves[0].edgeId};
}
function rollout(s) {
  // A cutoff is NOT a solved endgame. Follow captures only, rather than doing
  // an unbounded full-game playout at every leaf. This keeps node budgets useful.
  const initial=getScore(s);let t=s;
  while(t.toMove!==null){
    const counts=sideCounts(t);if(!counts.includes(3))break;
    const options=getLegalActions(t).map(a=>({...a,...immediate(t,a.edgeId,counts)}));
    options.sort((a,b)=>b.capturesNow-a.capturesNow||a.edgeId-b.edgeId);
    if(!options[0]?.capturesNow)break;t=applyAction(t,options[0]).state;
  }
  const last=getScore(t);return (last.jev-last.human)-(initial.jev-initial.human);
}
function searchKey(s,depth) { return `${s.toMove}:${depth}:${s.edges.map(e=>e===null?'0':'1').join('')}`; }
function evaluate(s,depth,ctx) {
  if(s.toMove===null) return {value:0,exact:true,complete:true};
  const key=searchKey(s,depth); if(ctx.memo.has(key)){ctx.cacheHits++;return ctx.memo.get(key);}
  if(depth===0||ctx.nodes>=ctx.limit) { ctx.cutoffs++; return {value:rollout(s),exact:false,complete:depth===0}; }
  ctx.nodes++; let value=s.toMove===1?-Infinity:Infinity,exact=true,complete=true;
  const counts=sideCounts(s);
  const ordered=getLegalActions(s).sort((a,b)=>immediate(s,b.edgeId,counts).capturesNow-immediate(s,a.edgeId,counts).capturesNow||a.edgeId-b.edgeId);
  for(const action of ordered) {
    const next=applyAction(s,action), reward=next.event.capturedBoxes.length*(s.toMove===1?1:-1);
    const child=evaluate(next.state,depth-1,ctx), v=reward+child.value;
    value=s.toMove===1?Math.max(value,v):Math.min(value,v); exact&&=child.exact; complete&&=child.complete;
  }
  const answer={value,exact,complete}; if(complete)ctx.memo.set(key,answer); return answer;
}
export function analyzeCandidates(s,difficulty='normal',overrides={}) {
  if(!PROFILES[difficulty]) throw new Error('Unknown difficulty.');
  const profile={...PROFILES[difficulty],...overrides}, before=sideCounts(s), legal=getLegalActions(s),score=getScore(s);
  const depth=legal.length<=profile.exactThreshold?legal.length:profile.depth;
  const perRoot=Math.floor(profile.nodes/Math.max(1,legal.length));
  return legal.map(({edgeId})=>{
    const start=performance.now(), f=immediate(s,edgeId,before), {state:next}=applyAction(s,{edgeId}), after=sideCounts(next);
    const nextLegal=getLegalActions(next);
    const candidate={edgeId,label:edgeLabel(s.size,edgeId),...f,nextPlayer:next.toMove,
      capturableAfter:after.filter(v=>v===3).length,
      opponentImmediateCapture:next.toMove!==null&&next.toMove!==s.toMove?Math.max(0,...nextLegal.map(a=>immediate(next,a.edgeId,after).capturesNow)):0,
      safeMovesAfter:nextLegal.filter(a=>{const v=immediate(next,a.edgeId,after);return !v.capturesNow&&!v.newThirdSides;}).length,
      componentsAfter:difficulty==='easy'?[]:components(next),search:null};
    if(depth>0||next.toMove===null) {
      const ctx={limit:perRoot,nodes:0,cacheHits:0,cutoffs:0,memo:new Map()};
      const result=evaluate(next,Math.max(0,depth-1),ctx), scoreAfter=getScore(next);
      candidate.search={estimate:scoreAfter.jev-scoreAfter.human+result.value,exact:result.exact,
        requestedDepth:depth,nodes:ctx.nodes,nodeBudget:perRoot,cacheHits:ctx.cacheHits,cutoffs:ctx.cutoffs};
    }
    candidate.featureMs=performance.now()-start; return candidate;
  });
}
export function selectLocal(s,candidates) {
  if(!candidates.length)throw new Error('No legal moves.');
  const sign=s.toMove===1?1:-1;
  return [...candidates].sort((a,b)=>{
    if(a.search&&b.search) { const difference=sign*(b.search.estimate-a.search.estimate);if(difference)return difference; }
    return b.capturesNow-a.capturesNow||a.newThirdSides-b.newThirdSides||a.edgeId-b.edgeId;
  })[0].edgeId;
}
export function exactRegret(candidates,edgeId,player) {
  if(!candidates.length||!candidates.every(c=>c.search?.exact))return null;
  const values=candidates.map(c=>c.search.estimate),chosen=candidates.find(c=>c.edgeId===edgeId)?.search.estimate;
  if(chosen===undefined)return null;
  return player===1?Math.max(...values)-chosen:chosen-Math.min(...values);
}
export function tacticalSnapshot(s) {
  const counts=sideCounts(s),legal=getLegalActions(s);
  return {sideHistogram:[0,1,2,3,4].map(n=>counts.filter(c=>c===n).length),
    safeEdges:legal.filter(a=>{const f=immediate(s,a.edgeId,counts);return !f.capturesNow&&!f.newThirdSides;}).length,
    captureEdges:legal.filter(a=>immediate(s,a.edgeId,counts).capturesNow>0).length,
    components:components(s)};
}
