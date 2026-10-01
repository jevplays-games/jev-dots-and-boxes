import test from 'node:test';import assert from 'node:assert/strict';
import {evaluate,evaluateReference,analyzeCandidates} from '../public/games/dots-and-boxes/analysis.js';
import {createInitialState,applyAction,getLegalActions} from '../public/games/dots-and-boxes/rules.js';
// The fast search must be the reference algorithm, not an approximation: same value, exactness, node budget use, cache hits and cutoffs.
let seed=2026;const rnd=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};
function randomState(ply){let s=createInitialState({size:4,firstPlayer:0});for(let i=0;i<ply&&s.toMove!==null;i++){const l=getLegalActions(s);s=applyAction(s,l[Math.floor(rnd()*l.length)]).state;}return s;}
const ctx=limit=>({limit,nodes:0,cacheHits:0,cutoffs:0,memo:new Map()});
test('fast search equals the reference search on random positions',()=>{
  let compared=0;
  for(let i=0;i<30;i++){
    const s=randomState(8+Math.floor(rnd()*26));if(s.toMove===null)continue;
    for(const [depth,limit] of [[1,40],[2,300],[3,400]]){
      const a=ctx(limit),b=ctx(limit),r1=evaluateReference(s,depth,a),r2=evaluate(s,depth,b);
      assert.deepEqual(r2,r1);assert.deepEqual({n:b.nodes,h:b.cacheHits,c:b.cutoffs},{n:a.nodes,h:a.cacheHits,c:a.cutoffs});compared++;
    }
  }
  assert.ok(compared>60);
});
test('fast search equals the reference search near the end of a game (exact depths)',()=>{
  for(let i=0;i<12;i++){
    const s=randomState(31+Math.floor(rnd()*6));if(s.toMove===null)continue;
    const depth=Math.min(getLegalActions(s).length,8),a=ctx(3000),b=ctx(3000);
    assert.deepEqual(evaluate(s,depth,b),evaluateReference(s,depth,a));assert.equal(b.nodes,a.nodes);
  }
});
test('the jev profile answers an opening position within a second of CPU',()=>{
  const s=applyAction(createInitialState({size:4,firstPlayer:0}),{edgeId:0}).state;
  const started=performance.now(),candidates=analyzeCandidates(s,'jev');
  assert.equal(candidates.length,39);assert.ok(performance.now()-started<3000,'the jev search regressed to the slow implementation');
});
