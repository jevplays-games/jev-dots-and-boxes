import {geometry,createInitialState,applyAction,getLegalActions,getScore,getOutcome,serialize,edgeLabel,exportReplay,replay} from './games/dots-and-boxes/rules.js';
import {analyzeCandidates,selectLocal,exactRegret,tacticalSnapshot} from './games/dots-and-boxes/analysis.js';
import {appendEvent,sha256,summarize,auditMatch,exportTables,csv} from './analytics.js';
const $=id=>document.getElementById(id), svgNS='http://www.w3.org/2000/svg';
const fmt=(n,d=0)=>Number.isFinite(n)?n.toLocaleString(undefined,{maximumFractionDigits:d}):'—';
const ms=n=>Number.isFinite(n)?`${fmt(n,n<100?1:0)} ms`:'—';
let session=null,match=null,online=true,busy=false,tab='overview',scope='world',cursor=null,replayOverride=null,replayTimer=null,toastTimer=null;
let launch=new URL(location.href).searchParams.get('launch');
if(launch||new URL(location.href).searchParams.has('auth'))history.replaceState(null,'',location.pathname);
let preferences={};try{preferences=JSON.parse(localStorage.getItem('dots-preferences')??'{}');}catch{}
$('difficulty').value=['easy','normal','hard','jev'].includes(preferences.difficulty)?preferences.difficulty:'jev';
$('telemetry-consent').checked=preferences.telemetry===true;
function savePreferences(){try{localStorage.setItem('dots-preferences',JSON.stringify({difficulty:$('difficulty').value,telemetry:$('telemetry-consent').checked}));}catch{}}
function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>{$('toast').hidden=true;},6000);}
async function api(path,method='GET',data){
  const response=await fetch(path,{method,credentials:'same-origin',headers:{...(data?{'Content-Type':'application/json','X-CSRF-Token':session?.csrf??''}:{})},...(data?{body:JSON.stringify(data)}:{})});
  const value=await response.json();if(!response.ok){const e=Error(value.message??value.error??'Request failed');e.status=response.status;e.code=value.error;throw e;}return value;
}
function telemetry(type,durationMs){
  if(!online||!match||match.preview||!$('telemetry-consent').checked)return;
  void api(`/api/matches/${match.id}/telemetry`,'POST',{consent:true,events:[{type,durationMs}]}).catch(()=>{});
}
function blankMatch(preview=true){
  const now=Date.now();return {id:crypto.randomUUID(),format:'dots-match-v1',preview,state:createInitialState(),revision:0,events:[],mode:'local',difficulty:$('difficulty').value,
    poolId:'offline-practice',profile:{model:'local-heuristic',difficulty:$('difficulty').value},ranked:false,requestedRanked:false,verified:false,status:'active',outcome:null,pending:null,
    createdAt:now,turnStartedAt:now,expiresAt:now+86400000,manifest:{runtime:'browser-offline',eventSchema:'dots-analytics-v1',analyticsVersion:'v1'}};
}
function saveLocal(){if(online||!match||match.preview)return;try{localStorage.setItem('dots-offline-match',JSON.stringify(match));}catch{toast('Browser storage is full. Export the current match to retain its analytics.');}}
async function loadEvents(){
  if(!online||match.preview)return;
  let after=match.events.length;
  while(true){const page=await api(`/api/matches/${match.id}/events?after=${after}`);match.events.push(...page.events);after=page.nextAfter;if(!page.hasMore)break;}
}
async function acceptSnapshot(value){const oldEvents=match?.id===value.id?match.events:[];match={...value,events:oldEvents};await loadEvents();render();}
async function refresh(){if(!online||match?.preview)return;await acceptSnapshot(await api(`/api/matches/${match.id}`));}
async function create(){
  replayOverride=null;stopReplay();savePreferences();
  if(online){await acceptSnapshot(await api('/api/matches','POST',{difficulty:$('difficulty').value,mode:$('mode').value,ranked:$('ranked').checked}));}
  else{match=blankMatch(false);await appendEvent(match,'match_created',{mode:'local',difficulty:match.difficulty,firstPlayer:0,initialStateHash:await sha256(serialize(match.state))});saveLocal();render();}
}
async function localCommit(edgeId,source,decisionId=null,candidates=null){
  const before=match.state,features=candidates??analyzeCandidates(before,'easy'),chosen=features.find(c=>c.edgeId===edgeId),now=Date.now();
  const transition=applyAction(before,{edgeId});match.state=transition.state;match.revision++;
  await appendEvent(match,'move_committed',{...transition.event,ply:match.state.ply,source,decisionId,preStateHash:await sha256(serialize(before)),postStateHash:await sha256(serialize(match.state)),score:getScore(match.state),
    features:chosen?{capturesNow:chosen.capturesNow,newThirdSides:chosen.newThirdSides,opponentImmediateCapture:chosen.opponentImmediateCapture,safeMovesAfter:chosen.safeMovesAfter}:null,
    captureAvailable:features.some(c=>c.capturesNow>0),exactRegret:exactRegret(features,edgeId,before.toMove),turnElapsedMs:now-match.turnStartedAt,tactics:tacticalSnapshot(match.state)},crypto.randomUUID());
  match.turnStartedAt=now;
  if(match.state.toMove===null){match.status='completed';match.outcome=getOutcome(match.state);match.finishedAt=Date.now();await appendEvent(match,'match_settled',{termination:'completed',outcome:match.outcome,score:getScore(match.state)});const checked=await auditMatch(match);match.verified=checked.ok;await appendEvent(match,'verification_completed',{ok:checked.ok,errors:checked.errors,rankedEligible:false});}
  saveLocal();render();
}
let analysisWorker=null;
function workerAnalysis(state,difficulty){
  return new Promise((resolve,reject)=>{
    if(!analysisWorker)analysisWorker=new Worker('/analysis-worker.js',{type:'module'});
    const id=crypto.randomUUID(),handler=({data})=>{if(data.id!==id)return;analysisWorker.removeEventListener('message',handler);data.error?reject(Error(data.error)):resolve(data);};
    analysisWorker.addEventListener('message',handler);analysisWorker.postMessage({id,state,difficulty});
  });
}
async function localOpponent(){
  const {candidates,featureMs}=await workerAnalysis(match.state,match.difficulty),decisionId=crypto.randomUUID(),edgeId=selectLocal(match.state,candidates),stateHash=await sha256(serialize(match.state));
  await appendEvent(match,'decision_prepared',{decisionId,stateHash,candidates,featureMs});
  await appendEvent(match,'decision_completed',{decisionId,edgeId,source:'local',model:'local-heuristic',candidateCount:candidates.length,featureMs,totalMs:featureMs,confidence:null,probabilities:null,
    searchNodes:candidates.reduce((n,c)=>n+(c.search?.nodes??0),0),searchCacheHits:candidates.reduce((n,c)=>n+(c.search?.cacheHits??0),0),allCandidatesExact:candidates.every(c=>c.search?.exact)});
  await localCommit(edgeId,'local',decisionId,candidates);
}
async function advance(){
  let waits=0;
  while(match?.status==='active'&&match.state.toMove===1){
    render();await new Promise(resolve=>setTimeout(resolve,200));
    if(online){
      const next=await api(`/api/matches/${match.id}/step`,'POST',{operation:'jev_advance',requestId:crypto.randomUUID(),expectedRevision:match.revision});await acceptSnapshot(next);
      if(next.pending){if(++waits>50)throw Error('The decision is still pending. Reload to reconnect.');await new Promise(resolve=>setTimeout(resolve,700));}
    }else await localOpponent();
  }
}
async function action(edgeId){
  if(busy||match?.state.toMove!==0||match?.status!=='active')return;
  busy=true;render();
  try{if(match.preview)await create();if(online)await acceptSnapshot(await api(`/api/matches/${match.id}/step`,'POST',{operation:'human_move',edgeId,requestId:crypto.randomUUID(),expectedRevision:match.revision}));else await localCommit(edgeId,'human');await advance();}
  catch(e){toast(e.message);telemetry('network_error');if(online){try{await refresh();}catch{}}}
  finally{busy=false;render();}
}
/* Auto-start: the board is playable as soon as the page is, with no click.
   Until now init() left a PREVIEW match on screen -- a board you could look at
   but not play -- and waited for New game. This converts that preview into a
   real match. It returns early unless the board is still that preview, so a
   resumed server match and a restored offline match are both left alone and a
   reload rejoins rather than opening a second match.
   Ranked is taken only when the checkbox is enabled, the same gate the player
   faces by hand (online, signed in, ranked capability, not local mode). $('mode')
   is already pinned to 'local' when the server reports no JEV, so an
   auto-started game is never relabeled as JEV. */
async function autoStart(){
  if(busy||!match?.preview)return;
  $('ranked').checked=!$('ranked').disabled;
  await startNew();
}
async function startNew(){
  busy=true;$('new-dialog').close();render();
  try{
    if(match&&!match.preview&&match.status==='active'){
      if(online)await api(`/api/matches/${match.id}/step`,'POST',{operation:'resign',requestId:crypto.randomUUID(),expectedRevision:match.revision});
      else{await appendEvent(match,'player_resigned',{});match.status='forfeit';match.outcome='loss';match.finishedAt=Date.now();saveLocal();}
    }
    await create();await advance();
  }catch(e){toast(e.message);if(online)try{await refresh();}catch{}}
  finally{busy=false;render();}
}
function buildBoard(){
  const active=document.activeElement?.classList.contains('edge')?Number(document.activeElement.dataset.id):null,s=match.state,g=geometry(s.size),fragment=document.createDocumentFragment();
  for(let r=0;r<=s.size;r++)for(let c=0;c<=s.size;c++){const d=document.createElement('span');d.className=`dot r${r*2} c${c*2}`;d.setAttribute('aria-hidden','true');fragment.append(d);}
  for(const box of g.boxes){const d=document.createElement('div'),v=s.boxes[box.id];d.className=`box-cell r${box.row*2+1} c${box.col*2+1}${v===null?'':v===0?' owned-human':' owned-jev'}`;d.textContent=v===null?'':v===0?'Y':'J';d.setAttribute('aria-label',`Box ${String.fromCharCode(65+box.col)}${box.row+1}: ${v===null?'unclaimed':v===0?'you':'opponent'}`);fragment.append(d);}
  const legal=getLegalActions(s),enabled=!busy&&s.toMove===0&&match.status==='active';
  const focusId=legal.some(a=>a.edgeId===active)?active:legal[0]?.edgeId;
  for(const edge of g.edges){
    const b=document.createElement('button'),v=s.edges[edge.id],r=edge.row*2+(edge.orientation==='v'?1:0),c=edge.col*2+(edge.orientation==='h'?1:0);
    b.className=`edge ${edge.orientation} r${r} c${c} ${v===null?'available':v===0?'owned-human':'owned-jev'}`;b.dataset.id=edge.id;
    const captures=edge.boxes.filter(id=>s.boxes[id]===null&&g.boxes[id].edges.filter(e=>s.edges[e]!==null).length===3).length;
    b.setAttribute('aria-label',`${edge.orientation==='h'?'Horizontal':'Vertical'} edge ${edgeLabel(s.size,edge.id)}, ${v===null?`available${captures?`, captures ${captures} ${captures===1?'box':'boxes'}`:''}`:v===0?'drawn by you':'drawn by opponent'}`);
    b.disabled=v!==null||!enabled;b.tabIndex=edge.id===focusId&&enabled?0:-1;b.addEventListener('click',()=>action(edge.id));
    b.addEventListener('keydown',event=>{
      const keys=['ArrowRight','ArrowDown','ArrowLeft','ArrowUp','Home','End'];if(!keys.includes(event.key))return;event.preventDefault();
      const ids=legal.map(a=>a.edgeId),idx=ids.indexOf(edge.id),next=event.key==='Home'?ids[0]:event.key==='End'?ids.at(-1):ids[(idx+(event.key==='ArrowRight'||event.key==='ArrowDown'?1:-1)+ids.length)%ids.length];
      const target=$('board').querySelector(`[data-id="${next}"]`);b.tabIndex=-1;if(target){target.tabIndex=0;target.focus();}
    });fragment.append(b);
  }
  $('board').replaceChildren(fragment);
  if(active!==null&&enabled)$('board').querySelector(`[data-id="${focusId}"]`)?.focus({preventScroll:true});
  $('legal-edges').replaceChildren(...legal.map(a=>{const option=document.createElement('option');option.value=a.edgeId;option.textContent=edgeLabel(s.size,a.edgeId);return option;}));
  $('draw-selected').disabled=!enabled;$('legal-edges').disabled=!enabled;
}
function recordRows(target,rows){target.replaceChildren(...rows.map(([name,value])=>{const row=document.createElement('div');row.className='record-row';const key=document.createElement('span'),v=document.createElement('strong');key.textContent=name;v.textContent=String(value);row.append(key,v);return row;}));}
function render(){
  if(!match)return;const start=performance.now(),s=match.state,score=getScore(s),summary=online&&match.summary?match.summary:summarize(match);
  $('human-score').textContent=score.human;$('jev-score').textContent=score.jev;$('human-score-large').textContent=score.human;$('jev-score-large').textContent=score.jev;
  const running=match.status==='active';$('human-card').classList.toggle('is-turn',running&&s.toMove===0);$('jev-card').classList.toggle('is-turn',running&&s.toMove===1);
  $('human-turn').hidden=!running||s.toMove!==0;$('jev-turn').hidden=!running||s.toMove!==1;$('opponent-name').textContent=match.mode==='jev'?'JEV':'LOCAL';
  $('remaining').textContent=`${s.edges.length-s.ply} EDGES LEFT`;
  let status=running?(busy?(s.toMove===1?'Evaluating the opponent’s move…':'Committing your move…'):'Your move. Draw a line between two dots.'):
    match.status==='forfeit'?'Match conceded.':match.outcome==='draw'?'A draw. Eight boxes each.':match.outcome==='win'?'You win. The board is complete.':'Opponent wins. The board is complete.';
  const lastMove=match.events.findLast(e=>e.type==='move_committed');if(running&&!busy&&lastMove?.data.player===0&&lastMove.data.capturedBoxes.length)status='You captured a box. Draw another line.';
  $('status').textContent=status;$('pipeline').classList.toggle('busy',busy&&s.toMove===1);
  $('eligibility').textContent=match.preview?'READY TO PLAY':match.ranked?(match.verified?'VERIFIED RANKED':'RANKED MATCH'):match.mode==='local'?'LOCAL PRACTICE':'UNRANKED JEV';
  $('notice').hidden=!match.notice;$('notice').textContent=match.notice??'';
  $('new-game').disabled=busy;$('ranked').disabled=!online||!session?.user||!session?.capabilities?.ranked||$('mode').value==='local';if($('ranked').disabled)$('ranked').checked=false;
  $('connection').textContent=online?'Server-authoritative · evidence stays with your match':'Browser-only practice · not eligible for leaderboards';
  $('agent-title').textContent=match.mode==='jev'?'JEV · '+(match.profile?.model??'pinned model'):'Local practice · not JEV';
  $('agent-state').textContent=busy&&s.toMove===1?'Waiting for a validated decision':`${match.difficulty[0].toUpperCase()+match.difficulty.slice(1)} · ${online?'server-authoritative':'offline browser'}`;
  buildBoard();renderDecision();$('event-count').textContent=match.events.length;
  if(tab==='overview')renderOverview(summary);if(tab==='candidates')renderCandidates();if(tab==='timeline')renderTimeline();if(tab==='replay')renderReplay();
  // Timing is available to opt-in diagnostics, sampled only on explicit actions.
  window.__lastRenderMs=performance.now()-start;
}
function renderDecision(){
  const d=match.events.findLast(e=>e.type==='decision_completed')?.data??match.lastDecision;
  const p=d?match.events.find(e=>e.type==='decision_prepared'&&e.data.decisionId===d.decisionId)?.data:null,c=p?.candidates.find(c=>c.edgeId===d.edgeId);
  $('selected-edge').textContent=d?edgeLabel(match.state.size,d.edgeId):'—';$('decision-source').textContent=d?`${d.source.toUpperCase()} · ${d.allCandidatesExact?'exactly solved position':'bounded evidence'}`:'Awaiting a decision';
  $('candidate-count').textContent=fmt(d?.candidateCount);$('decision-time').textContent=ms(d?.totalMs);$('confidence').textContent=d?.confidence===null||d?.confidence===undefined?'—':`${fmt(d.confidence*100,1)}%`;$('search-nodes').textContent=fmt(d?.searchNodes);
  if(c){$('factors').replaceChildren();recordRows($('factors'),[['Immediate captures',c.capturesNow],['New third sides',c.newThirdSides],['Safe moves afterward',c.safeMovesAfter],['Retains move',c.capturesNow?'Yes':'No'],['Search margin',c.search?`${fmt(c.search.estimate,1)} (${c.search.exact?'exact':'estimate'})`:'Not searched']]);}
}
function svgElement(tag,attributes,text){const e=document.createElementNS(svgNS,tag);for(const [k,v] of Object.entries(attributes))e.setAttribute(k,String(v));if(text!==undefined)e.textContent=text;return e;}
function chartGrid(svg,max,xlabel){svg.replaceChildren();for(let i=0;i<3;i++){const y=15+i*58;svg.append(svgElement('line',{x1:25,y1:y,x2:550,y2:y,class:'chart-grid-line'}),svgElement('text',{x:0,y:y+3,class:'chart-text'},fmt(max*(1-i/2))));}svg.append(svgElement('text',{x:25,y:155,class:'chart-text'},xlabel));}
function renderOverview(s){
  $('metric-moves').textContent=`${s.moveCount} / 40`;$('metric-calls').textContent=s.providerAttempts;$('metric-p50').textContent=ms(s.latencyMs.p50);$('metric-tokens').textContent=fmt(s.knownInputTokens);$('metric-fallbacks').textContent=s.fallbackDecisions;$('metric-cost').textContent=s.estimatedCostUsd===null?'Unknown':`$${fmt(s.estimatedCostUsd,5)}`;
  const moves=match.events.filter(e=>e.type==='move_committed').map(e=>e.data),decisions=match.events.filter(e=>e.type==='decision_completed').map(e=>e.data);
  chartGrid($('score-chart'),16,'0                                                     MOVE                                                     40');
  for(const [key,cls] of [['human','chart-human'],['jev','chart-jev']]){const points=[[25,131],...moves.map(m=>[25+m.ply/40*525,131-(m.score?.[key]??0)/16*116])];$('score-chart').append(svgElement('polyline',{points:points.map(p=>p.join(',')).join(' '),class:cls}));}
  const peak=Math.max(1,...decisions.map(d=>d.totalMs??0));chartGrid($('latency-chart'),peak,'OPPONENT DECISIONS');
  const width=Math.min(22,480/Math.max(1,decisions.length));decisions.forEach((d,i)=>{const h=(d.totalMs??0)/peak*116;const b=svgElement('rect',{x:30+i*(width+4),y:131-h,width,height:h,rx:2,class:'chart-bar'});b.append(svgElement('title',{},`Decision ${i+1}: ${ms(d.totalMs)}`));$('latency-chart').append(b);});
  const human=s.players[0],jev=s.players[1];recordRows($('tactical-record'),[['Scoring moves · you / opponent',`${human.scoringMoves} / ${jev.scoringMoves}`],['Double captures',`${human.doubleCaptures} / ${jev.doubleCaptures}`],['New third sides',`${human.newThirdSides} / ${jev.newThirdSides}`],['Declined available captures',`${human.declinedImmediateCapture} / ${jev.declinedImmediateCapture}`],['Longest consecutive move run',`${s.longestSamePlayerRun.human} / ${s.longestSamePlayerRun.jev}`],['Human server-observed turn median',ms(human.serverObservedTurnMs.p50)]]);
  recordRows($('integrity-record'),[['Events / committed edges',`${s.eventCount} / ${s.moveCount}`],['Decision latency · p95 / p99',`${ms(s.latencyMs.p95)} / ${ms(s.latencyMs.p99)}`],['Known output tokens / unknown-usage calls',`${s.knownOutputTokens} / ${s.unknownUsageAttempts}`],['Retries / provider failures',`${s.retries} / ${s.providerFailures}`],['Fully solved decisions',s.exactDecisions],['Exact regret · human / opponent',`${fmt(human.exactRegret.mean,2)} / ${fmt(jev.exactRegret.mean,2)}`],['Journal head',s.headHash?s.headHash.slice(0,18)+'…':'Not started']]);
}
function renderCandidates(){
  const selected=$('decision-select').value,prepared=match.events.filter(e=>e.type==='decision_prepared');
  $('decision-select').replaceChildren(...prepared.map((e,i)=>{const o=document.createElement('option');o.value=e.data.decisionId;o.textContent=`#${i+1} · ${e.data.candidates.length} legal edges`;return o;}));
  $('decision-select').value=prepared.some(e=>e.data.decisionId===selected)?selected:prepared.at(-1)?.data.decisionId??'';
  const p=prepared.find(e=>e.data.decisionId===$('decision-select').value)?.data,d=match.events.find(e=>e.type==='decision_completed'&&e.data.decisionId===p?.decisionId)?.data;
  $('candidate-rows').replaceChildren();if(!p){emptyRow($('candidate-rows'),9,'Candidate evidence appears after the first opponent decision.');return;}
  for(const c of p.candidates){const row=document.createElement('tr');if(d?.edgeId===c.edgeId)row.className='selected-row';
    const probability=d?.probabilities?.[String(c.edgeId)];for(const value of [c.label,d?.edgeId===c.edgeId?'Selected':'—',Number.isFinite(probability)?`${fmt(probability*100,2)}%`:'—',c.capturesNow,c.newThirdSides,c.safeMovesAfter,fmt(c.search?.estimate,2),c.search?c.search.exact?'Exact':'Estimate':'Features only',c.search?.nodes??0]){const td=document.createElement('td');td.textContent=value;row.append(td);}$('candidate-rows').append(row);}
}
function renderTimeline(){
  const filter=$('event-filter').value,events=match.events.filter(e=>filter==='all'||e.type===filter);
  $('timeline').replaceChildren(...events.slice().reverse().map(e=>{const detail=document.createElement('details');detail.className='event';const summary=document.createElement('summary'),seq=document.createElement('span'),name=document.createElement('b'),time=document.createElement('span'),pre=document.createElement('pre');seq.textContent=String(e.sequence).padStart(3,'0');name.textContent=e.type;time.textContent=`+${fmt(e.elapsedMs/1000,1)}s`;summary.append(seq,name,time);pre.textContent=JSON.stringify(e,null,2);detail.append(summary,pre);return detail;}));
  if(!events.length)$('timeline').textContent='No events in this view yet.';
}
function emptyRow(tbody,columns,message){const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=columns;td.textContent=message;tr.append(td);tbody.append(tr);}
function replayData(){return replayOverride??exportReplay(match.state,match.events,{difficulty:match.difficulty,model:match.profile?.model});}
function stopReplay(){clearInterval(replayTimer);replayTimer=null;$('replay-play').textContent='Play';}
function renderReplay(){
  let playback;try{playback=replay(replayData());}catch(e){toast(e.message);return;}
  const count=playback.states.length-1,index=Math.min(count,Number($('replay-slider').value)),s=playback.states[index],g=geometry(s.size),step=220/s.size,offset=20;
  $('replay-slider').max=count;$('replay-slider').value=index;$('replay-position').textContent=`${index} / ${count}`;
  const svg=svgElement('svg',{viewBox:'0 0 260 260',role:'img','aria-label':`Replay position ${index}. You ${getScore(s).human}, opponent ${getScore(s).jev}.`});
  for(const b of g.boxes)if(s.boxes[b.id]!==null){svg.append(svgElement('rect',{x:offset+b.col*step+4,y:offset+b.row*step+4,width:step-8,height:step-8,rx:4,class:s.boxes[b.id]===0?'replay-box-human':'replay-box-jev'}),svgElement('text',{x:offset+b.col*step+step/2,y:offset+b.row*step+step/2+4,'text-anchor':'middle',class:'replay-text'},s.boxes[b.id]===0?'Y':'J'));}
  for(const e of g.edges){const x=offset+e.col*step,y=offset+e.row*step;svg.append(svgElement('line',{x1:x,y1:y,x2:x+(e.orientation==='h'?step:0),y2:y+(e.orientation==='v'?step:0),class:s.edges[e.id]===null?'replay-line-empty':s.edges[e.id]===0?'replay-line-human':'replay-line-jev'}));}
  for(let r=0;r<=s.size;r++)for(let c=0;c<=s.size;c++)svg.append(svgElement('circle',{cx:offset+c*step,cy:offset+r*step,r:3.2,class:'replay-dot'}));
  $('replay-board').replaceChildren(svg);$('replay-description').textContent=`${replayOverride?'Imported or archived replay. ':''}You: ${getScore(s).human} · Opponent: ${getScore(s).jev} · ${s.toMove===null?'Board complete':s.toMove===0?'Your move next':'Opponent moves next'}`;
}
async function renderLeaderboard(more=false){
  if(!more){cursor=null;$('leaderboard-rows').replaceChildren();}$('leaderboard-status').textContent='Loading verified results…';
  if(!online){$('leaderboard-status').textContent='Leaderboards require the application server and Discord-ranked matches.';return;}
  try{const q=new URLSearchParams({scope,difficulty:$('difficulty').value,period:$('leaderboard-period').value});if(more&&cursor)q.set('cursor',cursor);const result=await api('/api/leaderboard?'+q);
    for(const r of result.rows){const tr=document.createElement('tr');for(const value of [r.rank??'Provisional',r.display_name,r.score_rate===null?'—':`${fmt(r.score_rate*100,1)}%`,r.wins,r.losses,r.draws,r.human_starts,r.jev_starts]){const td=document.createElement('td');td.textContent=value;tr.append(td);}$('leaderboard-rows').append(tr);}
    cursor=result.nextCursor;$('leaderboard-more').hidden=!cursor;$('leaderboard-status').textContent=result.rows.length?'Current rules, model and difficulty cohort.':'No verified ranked results in this view yet.';
  }catch(e){$('leaderboard-status').textContent=e.message;$('leaderboard-more').hidden=true;}
}
function download(text,type,name){const a=document.createElement('a'),url=URL.createObjectURL(new Blob([text],{type}));a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
async function exportData(format){
  if(match.preview){toast('Start a match before exporting.');return;}
  try{let text,type='application/json',extension='json';
    if(online){const r=await fetch(`/api/matches/${match.id}/export?format=${format}`,{credentials:'same-origin'});if(!r.ok)throw Error('Export failed.');text=await r.text();type=r.headers.get('content-type');}
    else if(format==='json')text=JSON.stringify(match,null,2);else if(format==='summary')text=JSON.stringify(summarize(match),null,2);else if(format==='replay')text=JSON.stringify(replayData(),null,2);else if(format==='jsonl')text=match.events.map(e=>JSON.stringify(e)).join('\n')+'\n';else text=csv(exportTables(match)[format]);
    if(format==='jsonl'){extension='jsonl';type='application/x-ndjson';}else if(['moves','decisions','candidates','attempts'].includes(format)){extension='csv';type='text/csv';}
    download(text,type,`dots-${match.id}-${format}.${extension}`);telemetry('export_clicked');
  }catch(e){toast(e.message);}
}
for(const button of document.querySelectorAll('[data-close]'))button.addEventListener('click',()=>$(button.dataset.close).close());
$('rules-open').addEventListener('click',()=>$('rules-dialog').showModal());$('export').addEventListener('click',()=>$('export-dialog').showModal());
for(const button of document.querySelectorAll('[data-export]'))button.addEventListener('click',()=>exportData(button.dataset.export));
$('new-game').addEventListener('click',()=>match&&!match.preview&&match.status==='active'?$('new-dialog').showModal():startNew());$('confirm-new').addEventListener('click',startNew);
$('draw-selected').addEventListener('click',()=>action(Number($('legal-edges').value)));
$('difficulty').addEventListener('change',()=>{savePreferences();if(!match.preview)toast('The selected difficulty applies to your next game.');if(tab==='leaderboard')void renderLeaderboard();});
$('mode').addEventListener('change',()=>{render();if(!match.preview)toast('The selected opponent applies to your next game.');});
$('telemetry-consent').addEventListener('change',()=>{savePreferences();telemetry('page_loaded');});
$('decision-select').addEventListener('change',renderCandidates);$('event-filter').addEventListener('change',renderTimeline);
for(const button of document.querySelectorAll('[data-tab]'))button.addEventListener('click',()=>{
  tab=button.dataset.tab;for(const b of document.querySelectorAll('[data-tab]')){b.classList.toggle('active',b===button);b.setAttribute('aria-selected',String(b===button));}
  for(const p of document.querySelectorAll('.tab-panel'))p.hidden=p.id!==`panel-${tab}`;stopReplay();render();if(tab==='leaderboard')void renderLeaderboard();if(tab==='replay')telemetry('replay_opened');
});
for(const b of document.querySelectorAll('[data-scope]'))b.addEventListener('click',()=>{scope=b.dataset.scope;for(const other of document.querySelectorAll('[data-scope]'))other.classList.toggle('selected',other===b);void renderLeaderboard();});
$('leaderboard-period').addEventListener('change',()=>void renderLeaderboard());$('leaderboard-more').addEventListener('click',()=>void renderLeaderboard(true));
$('replay-slider').addEventListener('input',()=>{stopReplay();renderReplay();});$('replay-prev').addEventListener('click',()=>{stopReplay();$('replay-slider').value=Math.max(0,Number($('replay-slider').value)-1);renderReplay();});$('replay-next').addEventListener('click',()=>{stopReplay();$('replay-slider').value=Number($('replay-slider').value)+1;renderReplay();});
$('replay-play').addEventListener('click',()=>{
  if(replayTimer){stopReplay();return;}if(Number($('replay-slider').value)>=Number($('replay-slider').max))$('replay-slider').value=0;
  $('replay-play').textContent='Pause';replayTimer=setInterval(()=>{const n=Number($('replay-slider').value)+1;if(n>Number($('replay-slider').max)){stopReplay();return;}$('replay-slider').value=n;renderReplay();},600);
});
$('import-replay').addEventListener('change',async event=>{const file=event.target.files[0];if(!file)return;try{if(file.size>1024*1024)throw Error('Replay exceeds the 1 MB import limit.');const value=JSON.parse(await file.text());replay(value);replayOverride=value;$('replay-slider').value=0;renderReplay();}catch(e){toast(e.message);}finally{event.target.value='';}});
$('audit').addEventListener('click',async()=>{try{const report=online&&!match.preview?await api(`/api/matches/${match.id}/export?format=audit`):await auditMatch(match);$('audit-result').textContent=report.ok?`Valid: ${report.events} hash-linked events; all moves and the final state replay correctly. This check is not an external signature.`:`Audit failed: ${report.errors.join('; ')}`;toast(report.ok?'Replay and event chain verified.':'Verification failed.');}catch(e){toast(e.message);}});
$('login').addEventListener('click',async()=>{
  if(!online||!session?.capabilities.discord){toast('Configure DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET and DISCORD_PUBLIC_KEY on the server to enable Discord.');return;}
  if(session.user){try{await api('/api/logout','POST',{});location.reload();}catch(e){toast(e.message);}return;}
  location.href='/api/auth/discord'+(launch?'?launch='+encodeURIComponent(launch):'');
});
document.addEventListener('visibilitychange',()=>{telemetry('visibility_changed');if(document.visibilityState==='visible'&&online&&!busy)void refresh().catch(()=>{});});
async function init(){
  try{
    session=await api('/api/session');$('login').textContent=session.user?`${session.user.display_name} · sign out`:'Sign in with Discord';
    $('mode').value=session.capabilities.jev?'jev':'local';$('mode').querySelector('[value="jev"]').disabled=!session.capabilities.jev;
    if(launch&&session.user){try{await api('/api/session/context','POST',{launch});session=await api('/api/session');launch=null;toast('Discord community context verified. Enable Ranked before starting an official match.');}catch(e){toast(e.message);}}
    if(session.activeMatchId)await acceptSnapshot(await api(`/api/matches/${session.activeMatchId}`));
    else{match=blankMatch(true);match.mode=$('mode').value;match.profile.model=session.capabilities.model;render();}
  }catch{
    online=false;$('mode').value='local';$('mode').querySelector('[value="jev"]').disabled=true;session={capabilities:{}};
    let restored=null;try{const raw=localStorage.getItem('dots-offline-match');if(raw){const m=JSON.parse(raw);if((await auditMatch(m)).ok)restored=m;}}catch{}
    match=restored??blankMatch(true);render();toast('Application API unavailable. Local browser practice is active; no ranked scores will be submitted.');
  }
  if(match.mode)$('mode').value=match.mode;if(match.difficulty)$('difficulty').value=match.difficulty;render();
  await autoStart();
  if(!match.preview&&match.status==='active'&&match.state.toMove===1){busy=true;render();try{await advance();}catch(e){toast(e.message);}finally{busy=false;render();}}
}
void init();
