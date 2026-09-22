import {analyzeCandidates,selectLocal,PROFILES,ANALYSIS_VERSION} from '../public/games/dots-and-boxes/analysis.js';
import {getScore,serialize,geometry} from '../public/games/dots-and-boxes/rules.js';
import {sha256,distributionMetrics} from '../public/analytics.js';
import {quota} from './common.js';
export const PROMPT_VERSION='choice-v1';
export const ENDPOINT='https://api.typesafe.ai/v1/systemone';
export const INSTRUCTIONS='Choose the legal edge that maximizes the acting player\'s final box count. Use the supplied computed facts. Completing one or two boxes retains the move; taking an available box is optional. The search estimate is final JEV minus human boxes; a negative value favors the human. Search estimates are not proofs unless exact is true. Chain handouts may preserve control, but are not always correct. Select only a supplied option.';
export function profileConfig(env,difficulty){return {sourceRevision:env.SOURCE_REVISION??'unversioned-local',rules:'dots-boxes-v1',analysis:ANALYSIS_VERSION,prompt:PROMPT_VERSION,model:env.JEV_MODEL??'jev-1.13.0',difficulty,search:PROFILES[difficulty],instructions:INSTRUCTIONS};}
export async function prepareDecision(state,difficulty,model,analysisOverrides={}){
  const start=performance.now(),candidates=analyzeCandidates(state,difficulty,analysisOverrides),featureMs=performance.now()-start;
  if(!candidates.length)throw Error('No legal actions.');
  let admissible=candidates;
  if(difficulty==='jev'&&candidates.every(c=>c.search?.exact)){
    const best=(state.toMove===1?Math.max:Math.min)(...candidates.map(c=>c.search.estimate));admissible=candidates.filter(c=>c.search.estimate===best);
  }
  const clean=c=>{const {featureMs,...value}=c;return value;};
  const request={model,state:{game:'dots-and-boxes',boardSize:state.size,actingPlayer:state.toMove===1?'JEV':'human',score:getScore(state),
    remainingEdges:candidates.length,remainingBoxes:state.boxes.filter(b=>b===null).length,
    board:{edges:geometry(state.size).edges.map(e=>({id:e.id,orientation:e.orientation,row:e.row,col:e.col,owner:state.edges[e.id]})),boxes:state.boxes},
    rules:{completingBoxesRetainsMove:true,takingAvailableBoxesIsOptional:true,oneActionDrawsOneEdge:true}},
    questions:{move:{type:'choice',instructions:INSTRUCTIONS,criteria:Object.fromEntries(admissible.map(c=>[String(c.edgeId),clean(c)]))}}};
  return {decisionId:crypto.randomUUID(),stateHash:await sha256(serialize(state)),candidates,admissibleIds:admissible.map(c=>c.edgeId),featureMs,request,requestHash:await sha256(request)};
}
export function validateProviderResponse(value,ids,model){
  const invalid=()=>{const e=Error('Malformed or inconsistent provider response.');e.code='invalid_response';throw e;};
  if(value?.model!==model) { const e=Error('Provider model did not match the pinned model.');e.code='model_mismatch';throw e; }
  const a=value.answers?.move;
  if(a?.type!=='choice'||typeof a.choice!=='string'||!a.probabilities||typeof a.probabilities!=='object'||Array.isArray(a.probabilities))invalid();
  const expected=ids.map(String).sort(),actual=Object.keys(a.probabilities).sort();
  if(JSON.stringify(expected)!==JSON.stringify(actual)||!expected.includes(a.choice))invalid();
  const probabilities=Object.fromEntries(expected.map(k=>[k,a.probabilities[k]])),p=Object.values(probabilities);
  if(p.some(x=>typeof x!=='number'||!Number.isFinite(x)||x<0||x>1)||Math.abs(p.reduce((x,y)=>x+y,0)-1)>0.001||!Number.isFinite(a.confidence)||a.confidence<0||a.confidence>1)invalid();
  const maximum=Math.max(...p);if(Math.abs(probabilities[a.choice]-maximum)>1e-9)invalid();
  const edgeId=Math.min(...ids.filter(id=>Math.abs(probabilities[String(id)]-maximum)<1e-9));
  const usage=value.usage&&Number.isInteger(value.usage.input_tokens)&&value.usage.input_tokens>=0&&Number.isInteger(value.usage.output_tokens)&&value.usage.output_tokens>=0?{input_tokens:value.usage.input_tokens,output_tokens:value.usage.output_tokens}:null;
  return {edgeId,confidence:a.confidence,probabilities,usage,response:{model:value.model,answers:{move:{type:'choice',choice:a.choice,confidence:a.confidence,probabilities}},usage}};
}
function cost(usage,env){
  if(!usage||env.INPUT_USD_PER_MILLION===undefined||env.OUTPUT_USD_PER_MILLION===undefined||env.INPUT_USD_PER_MILLION===''||env.OUTPUT_USD_PER_MILLION==='')return null;
  const i=Number(env.INPUT_USD_PER_MILLION),o=Number(env.OUTPUT_USD_PER_MILLION);
  return Number.isFinite(i)&&i>=0&&Number.isFinite(o)&&o>=0?(usage.input_tokens*i+usage.output_tokens*o)/1e6:null;
}
export async function evaluatePrepared(prepared,state,mode,env){
  const started=performance.now(),attempts=[],base={decisionId:prepared.decisionId,requestHash:prepared.requestHash,stateHash:prepared.stateHash,
    player:state.toMove,candidateCount:prepared.candidates.length,admissibleCount:prepared.admissibleIds.length,featureMs:prepared.featureMs,
    searchNodes:prepared.candidates.reduce((n,c)=>n+(c.search?.nodes??0),0),searchCacheHits:prepared.candidates.reduce((n,c)=>n+(c.search?.cacheHits??0),0),
    allCandidatesExact:prepared.candidates.every(c=>c.search?.exact),requestBytes:new TextEncoder().encode(JSON.stringify(prepared.request)).length,model:prepared.request.model};
  const finish=(data)=>({...base,confidence:null,probabilities:null,...distributionMetrics(data.probabilities),...data,totalMs:prepared.featureMs+performance.now()-started,attempts});
  // Offline mode must be visibly local, even when only one edge remains.
  if(mode==='local')return finish({edgeId:selectLocal(state,prepared.candidates),source:'local'});
  if(prepared.admissibleIds.length===1)return finish({edgeId:prepared.admissibleIds[0],source:prepared.candidates.length===1?'forced':'solver'});
  if(!env.TYPESAFE_API_KEY)return finish({edgeId:selectLocal(state,prepared.candidates),source:'fallback',failure:'not_configured'});
  const fetcher=env.FETCH??fetch; let failure='provider_unavailable';
  for(let attempt=1;attempt<=2;attempt++){
    const begin=performance.now(),record={decisionId:prepared.decisionId,attempt,ok:false,status:null,errorCode:null,usage:null,estimatedCostUsd:null};
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),Number(env.JEV_TIMEOUT_MS??5000));let retry=false,backoff=250*attempt;
    try{
      if(env.DB)await quota(env,'provider-global-day',Number(env.MAX_PROVIDER_CALLS_PER_DAY??2000),86400000);
      const response=await fetcher(ENDPOINT,{method:'POST',headers:{Authorization:`Bearer ${env.TYPESAFE_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify(prepared.request),signal:controller.signal});record.status=response.status;
      if(!response.ok){
        retry=[429,529].includes(response.status)||response.status>=500;
        const raw=response.headers.get('retry-after');if(raw){const ms=/^\d+(\.\d+)?$/.test(raw)?Number(raw)*1000:Date.parse(raw)-Date.now();if(Number.isFinite(ms)){if(ms>2000)retry=false;else backoff=Math.max(backoff,ms);}}
        const e=Error('Provider HTTP error');e.code=`http_${response.status}`;throw e;
      }
      const text=await response.text();if(text.length>1000000){const e=Error('Response too large');e.code='invalid_response';throw e;}
      let value;try{value=JSON.parse(text);}catch{const e=Error('Invalid JSON');e.code='invalid_response';throw e;}
      const parsed=validateProviderResponse(value,prepared.admissibleIds,prepared.request.model);
      record.responseBytes=new TextEncoder().encode(text).length;record.ok=true;record.usage=parsed.usage;record.estimatedCostUsd=cost(parsed.usage,env);record.latencyMs=performance.now()-begin;attempts.push(record);
      return finish({...parsed,source:'jev'});
    }catch(error){
      record.errorCode=typeof error.code==='string'?error.code:(error.name==='AbortError'?'timeout':'network_error');failure=record.errorCode;
      if(typeof error.code!=='string')retry=true;
      record.latencyMs=performance.now()-begin;attempts.push(record);
      if(!retry||attempt===2)break;
    }finally{clearTimeout(timer);}
    await new Promise(resolve=>setTimeout(resolve,backoff));
  }
  return finish({edgeId:selectLocal(state,prepared.candidates),source:'fallback',failure});
}
