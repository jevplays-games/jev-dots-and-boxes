/** Bounded, reproducible paired benchmark. Live mode requires an explicit --mode jev. */
import {mkdir,writeFile} from 'node:fs/promises';import {resolve} from 'node:path';
import {createInitialState,applyAction,getLegalActions,getScore,getOutcome,serialize} from '../public/games/dots-and-boxes/rules.js';
import {analyzeCandidates,heuristicAction,selectLocal,exactRegret,tacticalSnapshot} from '../public/games/dots-and-boxes/analysis.js';
import {prepareDecision,evaluatePrepared,profileConfig} from '../src/jev.js';
import {appendEvent,sha256,auditMatch,summarize,csv,statistics} from '../public/analytics.js';
try{process.loadEnvFile();}catch(error){if(error.code!=='ENOENT')throw error;}
const options=Object.fromEntries(process.argv.slice(2).reduce((pairs,v,i,a)=>{if(v.startsWith('--'))pairs.push([v.slice(2),a[i+1]]);return pairs;},[]));
const pairs=Number(options.pairs??4),mode=options.mode??'local',difficulty=options.difficulty??'normal',opponent=options.opponent??'random',seed=Number(options.seed??20260922),out=resolve(options.out??'bench/output'),size=Number(options.size??4);
if(!Number.isInteger(pairs)||pairs<1||pairs>10000||!['local','jev'].includes(mode)||!['random','greedy','heuristic','search','jev'].includes(opponent))throw Error('Invalid benchmark arguments.');
if((mode==='jev'||opponent==='jev')&&!process.env.TYPESAFE_API_KEY)throw Error('Live JEV mode requires TYPESAFE_API_KEY. No silent substitution.');
const env={...process.env,JEV_MODEL:process.env.JEV_MODEL??'jev-1.13.0'},profile=profileConfig(env,difficulty),poolId=await sha256(profile),rows=[],pairRows=[];
const randomFor=s=>()=>{s=(1664525*s+1013904223)>>>0;return s/4294967296;};
await mkdir(out,{recursive:true});
for(let pair=0;pair<pairs;pair++){
  const pairGames=[];
  for(const firstPlayer of [0,1]){
    const random=randomFor(seed+pair),createdAt=Date.now(),m={format:'dots-match-v1',id:crypto.randomUUID(),state:createInitialState({size,firstPlayer}),events:[],profile,poolId,difficulty,mode,ranked:false,verified:false,status:'active',outcome:null,createdAt,turnStartedAt:createdAt,manifest:{benchmark:true,seed:seed+pair,pair,firstPlayer,mode,opponent,profile,node:process.version,sourceRevision:env.SOURCE_REVISION??'unversioned-local'}};
    await appendEvent(m,'match_created',{initialStateHash:await sha256(serialize(m.state)),firstPlayer,profile,mode,opponent});
    while(m.state.toMove!==null){
      const s=m.state,actor=s.toMove,now=performance.now();let edgeId,decisionId=null,source=actor===0?opponent:mode,candidates;
      if(actor===1||opponent==='jev'){
        const prepared=await prepareDecision(s,difficulty,profile.model);candidates=prepared.candidates;decisionId=prepared.decisionId;await appendEvent(m,'decision_prepared',prepared);
        const decision=await evaluatePrepared(prepared,s,actor===0?'jev':mode,env);
        if(decision.source==='fallback')throw Error(`Benchmark stopped on provider failure (${decision.failure}); no mixed fallback cohort accepted.`);
        for(const a of decision.attempts)await appendEvent(m,'provider_attempt',a);const {attempts,...evidence}=decision;await appendEvent(m,'decision_completed',evidence);edgeId=decision.edgeId;source=decision.source;
      }else{
        candidates=analyzeCandidates(s,opponent==='search'?'normal':'easy');
        if(opponent==='random'){const legal=getLegalActions(s);edgeId=legal[Math.floor(random()*legal.length)].edgeId;}
        else if(opponent==='greedy')edgeId=[...candidates].sort((a,b)=>b.capturesNow-a.capturesNow||a.edgeId-b.edgeId)[0].edgeId;
        else edgeId=opponent==='search'?selectLocal(s,candidates):heuristicAction(s).edgeId;
      }
      const transition=applyAction(s,{edgeId});m.state=transition.state;
      const f=candidates.find(c=>c.edgeId===edgeId);
      await appendEvent(m,'move_committed',{...transition.event,ply:m.state.ply,decisionId,source,preStateHash:await sha256(serialize(s)),postStateHash:await sha256(serialize(m.state)),score:getScore(m.state),
        features:{capturesNow:f.capturesNow,newThirdSides:f.newThirdSides,safeMovesAfter:f.safeMovesAfter,opponentImmediateCapture:f.opponentImmediateCapture},captureAvailable:candidates.some(c=>c.capturesNow>0),exactRegret:exactRegret(candidates,edgeId,actor),turnElapsedMs:performance.now()-now,tactics:tacticalSnapshot(m.state)});
    }
    m.status='completed';m.outcome=getOutcome(m.state);m.finishedAt=Date.now();await appendEvent(m,'match_settled',{termination:'completed',outcome:m.outcome,score:getScore(m.state)});
    const audit=await auditMatch(m);if(!audit.ok)throw Error(audit.errors.join('; '));m.verified=true;await appendEvent(m,'verification_completed',{ok:true,rankedEligible:false,headHash:audit.headHash});
    const summary=summarize(m),score=getScore(m.state),row={pair,seed:seed+pair,firstPlayer,mode,opponent,difficulty,humanBoxes:score.human,jevBoxes:score.jev,jevScoreRate:score.jev===score.human?.5:score.jev>score.human?1:0,jevMargin:score.jev-score.human,decisions:summary.decisionCount,providerAttempts:summary.providerAttempts,latencyMeanMs:summary.latencyMs.mean,knownInputTokens:summary.knownInputTokens,knownOutputTokens:summary.knownOutputTokens,estimatedCostUsd:summary.estimatedCostUsd,headHash:summary.headHash};
    rows.push(row);pairGames.push(row);await writeFile(resolve(out,`pair-${String(pair).padStart(3,'0')}-seat-${firstPlayer}.json`),JSON.stringify(m));
  }
  pairRows.push({pair,meanScore:pairGames.reduce((n,r)=>n+r.jevScoreRate,0)/2,meanMargin:pairGames.reduce((n,r)=>n+r.jevMargin,0)/2});
}
function bootstrap(key){if(pairRows.length<2)return null;const random=randomFor(seed^0xabcdef),samples=[];for(let n=0;n<2000;n++){let sum=0;for(let i=0;i<pairRows.length;i++)sum+=pairRows[Math.floor(random()*pairRows.length)][key];samples.push(sum/pairRows.length);}samples.sort((a,b)=>a-b);return [samples[Math.floor(samples.length*.025)],samples[Math.floor(samples.length*.975)]];}
const report={schema:'dots-benchmark-v1',createdAt:new Date().toISOString(),pairs,games:rows.length,mode,opponent,difficulty,size,seed,poolId,profile,
  jevSeatBalancedScoreRate:pairRows.reduce((n,r)=>n+r.meanScore,0)/pairs,jevMeanBoxMargin:pairRows.reduce((n,r)=>n+r.meanMargin,0)/pairs,
  pairBootstrap95:{scoreRate:bootstrap('meanScore'),boxMargin:bootstrap('meanMargin')},latencyMeanAcrossGamesMs:statistics(rows.map(r=>r.latencyMeanMs)),providerAttempts:rows.reduce((n,r)=>n+r.providerAttempts,0),
  warnings:[mode==='local'?'This measures a local search/heuristic system, NOT live JEV quality.':'This measures the JEV-assisted system, not the model in isolation.',opponent==='random'?'Intervals resample the observed seed pairs only; this small smoke cohort is not a broad strength estimate.':'Deterministic opponent repetitions may be duplicates; confidence intervals are descriptive, not independent quality evidence.','Timing is specific to this machine and run.','No hidden live calls are made when both modes are local.']};
await writeFile(resolve(out,'summary.json'),JSON.stringify(report,null,2));await writeFile(resolve(out,'games.csv'),csv(rows));await writeFile(resolve(out,'pairs.csv'),csv(pairRows));console.log(JSON.stringify(report,null,2));
