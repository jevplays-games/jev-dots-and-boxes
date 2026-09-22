/** Pure deterministic Dots and Boxes rules. No DOM, I/O, RNG or external packages. */
export const GAME_ID = 'dots-and-boxes';
export const RULES_VERSION = 'dots-boxes-v1';
const geometries = new Map();
const owner = value => value === null || value === 0 || value === 1;
export function geometry(size = 4) {
  if (!Number.isInteger(size) || size < 1 || size > 6) throw new Error('Board size must be an integer from 1 to 6.');
  if (geometries.has(size)) return geometries.get(size);
  const n = size, offset = n * (n + 1);
  const H = (r, c) => r * n + c, V = (r, c) => offset + r * (n + 1) + c;
  const edges = [], boxes = [];
  for (let r = 0; r <= n; r++) for (let c = 0; c < n; c++) edges.push({ id: H(r,c), orientation: 'h', row:r, col:c, boxes: [] });
  for (let r = 0; r < n; r++) for (let c = 0; c <= n; c++) edges.push({ id: V(r,c), orientation: 'v', row:r, col:c, boxes: [] });
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    const id = r*n+c, list = [H(r,c),H(r+1,c),V(r,c),V(r,c+1)];
    boxes.push(Object.freeze({ id, row:r, col:c, edges:Object.freeze(list) }));
    for (const e of list) edges[e].boxes.push(id);
  }
  edges.forEach(e => { Object.freeze(e.boxes); Object.freeze(e); });
  const result = Object.freeze({ size:n, edges:Object.freeze(edges), boxes:Object.freeze(boxes), edgeCount:edges.length, boxCount:boxes.length });
  geometries.set(n,result); return result;
}
export function createInitialState({ size=4, firstPlayer=0 }={}) {
  const g=geometry(size);
  if (firstPlayer !== 0 && firstPlayer !== 1) throw new Error('Invalid starting player.');
  return { rulesVersion:RULES_VERSION,size,firstPlayer,toMove:firstPlayer,ply:0,edges:Array(g.edgeCount).fill(null),boxes:Array(g.boxCount).fill(null) };
}
export function getLegalActions(state) { return state.toMove === null ? [] : state.edges.flatMap((v,i)=>v===null?[{edgeId:i}]:[]); }
export function isTerminal(state) { return state.ply === geometry(state.size).edgeCount; }
export function getScore(state) { return { human:state.boxes.filter(x=>x===0).length, jev:state.boxes.filter(x=>x===1).length }; }
export function getOutcome(state) {
  if (!isTerminal(state)) return null;
  const s=getScore(state); return s.human===s.jev?'draw':s.human>s.jev?'win':'loss';
}
export function applyAction(state, action) {
  const id=action?.edgeId, g=geometry(state.size);
  if (state.rulesVersion!==RULES_VERSION) throw new Error('Unsupported rules version.');
  if (state.toMove !== 0 && state.toMove !== 1) throw new Error('The game is complete.');
  if (!Number.isInteger(id) || id<0 || id>=g.edgeCount) throw new Error('Invalid edge.');
  if (state.edges[id]!==null) throw new Error('Edge already drawn.');
  const player=state.toMove, edges=state.edges.slice(), boxes=state.boxes.slice(); edges[id]=player;
  const capturedBoxes=g.edges[id].boxes.filter(b=>boxes[b]===null && g.boxes[b].edges.every(e=>edges[e]!==null));
  capturedBoxes.forEach(b=>{boxes[b]=player;});
  const ply=state.ply+1, terminal=ply===g.edgeCount, retainsMove=capturedBoxes.length>0;
  const next={...state,edges,boxes,ply,toMove:terminal?null:retainsMove?player:1-player};
  return { state:next,event:{player,edgeId:id,capturedBoxes,retainsMove,terminal} };
}
export function validateState(s) {
  if (!s || s.rulesVersion!==RULES_VERSION) throw new Error('Unsupported state.');
  const g=geometry(s.size);
  if (![0,1].includes(s.firstPlayer) || ![null,0,1].includes(s.toMove) || !Number.isInteger(s.ply)) throw new Error('Invalid state header.');
  if (!Array.isArray(s.edges)||s.edges.length!==g.edgeCount||!s.edges.every(owner)||!Array.isArray(s.boxes)||s.boxes.length!==g.boxCount||!s.boxes.every(owner)) throw new Error('Invalid board arrays.');
  if (s.ply!==s.edges.filter(v=>v!==null).length || (s.toMove===null)!==isTerminal(s)) throw new Error('Inconsistent move count.');
  for (const b of g.boxes) if ((s.boxes[b.id]!==null)!==b.edges.every(e=>s.edges[e]!==null)) throw new Error('Inconsistent box ownership.');
  return s;
}
export function serialize(state) { validateState(state); return JSON.stringify({rulesVersion:state.rulesVersion,size:state.size,firstPlayer:state.firstPlayer,toMove:state.toMove,ply:state.ply,edges:state.edges,boxes:state.boxes}); }
export function deserialize(text) { return validateState(JSON.parse(text)); }
export function edgeLabel(size, id) {
  const e=geometry(size).edges[id]; if (!e) throw new Error('Invalid edge.');
  const a=String.fromCharCode(65+e.col)+(e.row+1), b=String.fromCharCode(65+e.col+(e.orientation==='h'?1:0))+(e.row+1+(e.orientation==='v'?1:0));
  return `${a}–${b}`;
}
export function exportReplay(state, events=[], opponent={}) {
  return {format:'jev-arcade-replay-v1',game:GAME_ID,rulesVersion:RULES_VERSION,boardSize:state.size,firstPlayer:state.firstPlayer,opponent,actions:events.filter(e=>e.type==='move_committed').map(e=>({edgeId:e.data.edgeId})),termination:isTerminal(state)?'completed':'in_progress'};
}
export function replay(data) {
  if (!data || data.format!=='jev-arcade-replay-v1'||data.game!==GAME_ID||data.rulesVersion!==RULES_VERSION) throw new Error('Unsupported replay.');
  let state=createInitialState({size:data.boardSize,firstPlayer:data.firstPlayer});
  if (!Array.isArray(data.actions)||data.actions.length>state.edges.length) throw new Error('Invalid action count.');
  const states=[state];
  for (const a of data.actions) { state=applyAction(state,a).state; states.push(state); }
  return {state,states,outcome:getOutcome(state),score:getScore(state)};
}
export const dotsAndBoxes={id:GAME_ID,version:RULES_VERSION,createInitialState,getLegalActions,applyAction,isTerminal,getScore,getOutcome,serialize,deserialize};
