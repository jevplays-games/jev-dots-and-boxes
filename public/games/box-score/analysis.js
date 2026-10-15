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
export function evaluateReference(s,depth,ctx) {
  if(s.toMove===null) return {value:0,exact:true,complete:true};
  const key=searchKey(s,depth); if(ctx.memo.has(key)){ctx.cacheHits++;return ctx.memo.get(key);}
  if(depth===0||ctx.nodes>=ctx.limit) { ctx.cutoffs++; return {value:rollout(s),exact:false,complete:depth===0}; }
  ctx.nodes++; let value=s.toMove===1?-Infinity:Infinity,exact=true,complete=true;
  const counts=sideCounts(s);
  const ordered=getLegalActions(s).sort((a,b)=>immediate(s,b.edgeId,counts).capturesNow-immediate(s,a.edgeId,counts).capturesNow||a.edgeId-b.edgeId);
  for(const action of ordered) {
    const next=applyAction(s,action), reward=next.event.capturedBoxes.length*(s.toMove===1?1:-1);
    const child=evaluateReference(next.state,depth-1,ctx), v=reward+child.value;
    value=s.toMove===1?Math.max(value,v):Math.min(value,v); exact&&=child.exact; complete&&=child.complete;
  }
  const answer={value,exact,complete}; if(complete)ctx.memo.set(key,answer); return answer;
}
/* Fast search: the same algorithm as evaluateReference (same move order, node budget, memo semantics, cutoffs and
   results) on one mutable board with undo, typed arrays and a numeric memo key, instead of cloning the state and
   building string keys at every node. evaluateReference stays as the readable specification; tests/search-equivalence
   asserts both agree on value, exactness, node/cache/cutoff counters. Boards with more than 48 edges use the reference. */
const fastTables=new Map();
function fastTable(size) {
  if(fastTables.has(size)) return fastTables.get(size);
  const g=geometry(size),E=g.edgeCount,B=g.boxCount;
  const edgeBoxes=g.edges.map(e=>Int32Array.from(e.boxes)),pow2=new Float64Array(E);
  for(let i=0;i<E;i++) pow2[i]=2**i;
  const table={E,B,edgeBoxes,pow2}; fastTables.set(size,table); return table;
}
function evaluateFast(s,depth,ctx) {
  const {E,B,edgeBoxes,pow2}=fastTable(s.size), drawn=new Uint8Array(E), cnt=new Uint8Array(B);
  let mask=0, ply=0;
  const g=geometry(s.size);
  for(let e=0;e<E;e++) if(s.edges[e]!==null){drawn[e]=1;mask+=pow2[e];ply++;for(const b of g.edges[e].boxes)cnt[b]++;}
  const levelOrder=[],levelCaps=[];
  const draw=e=>{drawn[e]=1;mask+=pow2[e];ply++;const bs=edgeBoxes[e];for(let i=0;i<bs.length;i++)cnt[bs[i]]++;};
  const undraw=e=>{drawn[e]=0;mask-=pow2[e];ply--;const bs=edgeBoxes[e];for(let i=0;i<bs.length;i++)cnt[bs[i]]--;};
  const capturesNow=e=>{const bs=edgeBoxes[e];let n=0;for(let i=0;i<bs.length;i++)if(cnt[bs[i]]===3)n++;return n;};
  // Follows captures only (highest capture count, then lowest edge id), then restores the board.
  function rollout(toMove) {
    let gained=0,t=toMove;const taken=[];
    while(t!==null){
      let best=-1,bestC=0;
      for(let e=0;e<E;e++){if(drawn[e])continue;const c=capturesNow(e);if(c>bestC){bestC=c;best=e;}}
      if(bestC===0)break;
      gained+=bestC*(t===1?1:-1);draw(best);taken.push(best);
      if(ply===E)t=null;
    }
    for(let i=taken.length-1;i>=0;i--)undraw(taken[i]);
    return gained;
  }
  function search(toMove,depth,level) {
    if(toMove===null) return {value:0,exact:true,complete:true};
    const key=mask*32+toMove*16+depth;
    const hit=ctx.memo.get(key); if(hit!==undefined){ctx.cacheHits++;return hit;}
    if(depth===0||ctx.nodes>=ctx.limit){ctx.cutoffs++;return {value:rollout(toMove),exact:false,complete:depth===0};}
    ctx.nodes++;
    let value=toMove===1?-Infinity:Infinity,exact=true,complete=true;
    // Order: captures first (more captured boxes first), then ascending edge id: same as the reference's stable sort.
    let order=levelOrder[level],caps=levelCaps[level];
    if(order===undefined){order=levelOrder[level]=new Int32Array(E);caps=levelCaps[level]=new Int8Array(E);}
    let n=0;const byCaps=[[],[],[]];
    for(let e=0;e<E;e++){if(drawn[e])continue;const c=capturesNow(e);caps[e]=c;byCaps[c].push(e);}
    for(let c=2;c>=0;c--)for(const e of byCaps[c])order[n++]=e;
    const sign=toMove===1?1:-1;
    for(let i=0;i<n;i++){
      const e=order[i],c=caps[e];
      draw(e);
      const next=ply===E?null:c>0?toMove:1-toMove;
      const child=search(next,depth-1,level+1),v=c*sign+child.value;
      undraw(e);
      value=toMove===1?Math.max(value,v):Math.min(value,v);exact&&=child.exact;complete&&=child.complete;
    }
    const answer={value,exact,complete};if(complete)ctx.memo.set(key,answer);return answer;
  }
  return search(s.toMove,depth,0);
}
export function evaluate(s,depth,ctx) { return geometry(s.size).edgeCount<=48?evaluateFast(s,depth,ctx):evaluateReference(s,depth,ctx); }
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
