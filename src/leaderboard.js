import {all,first,fail,json} from './common.js';
import {poolId} from './matches.js';
import {PROFILES} from '../public/games/dots-and-boxes/analysis.js';
export async function leaderboard(request,env,session){
  const q=new URL(request.url).searchParams,scope=q.get('scope')??'world',difficulty=q.get('difficulty')??'normal',period=q.get('period')??'month';
  if(!['world','server','channel'].includes(scope)||!PROFILES[difficulty]||!['month','all'].includes(period))fail(400,'invalid_filters');
  let context=null;
  if(scope!=='world'){
    if(!session?.user_id||!session.context_json)fail(403,'community_context_required','Launch from Discord to view this community.');
    context=JSON.parse(session.context_json);if(context.expiresAt<=Date.now())fail(403,'community_context_expired','Launch from Discord again to renew community access.');
  }
  const pool=await poolId(env,difficulty),season=new Date().toISOString().slice(0,7),args=[pool];
  let where="m.pool_id=? AND m.ranked=1 AND m.verified=1 AND m.status IN('completed','forfeit')";
  if(period==='month'){where+=' AND m.season_id=?';args.push(season);}
  if(scope==='server'){where+=' AND m.guild_id=?';args.push(context.guildId);}
  if(scope==='channel'){where+=' AND m.guild_id=? AND m.channel_id=?';args.push(context.guildId,context.channelId);}
  const signature=[scope,difficulty,period,pool,scope==='world'?'':scope==='server'?context.guildId:context.channelId].join(':');
  let last=null;
  if(q.get('cursor')){try{if(q.get('cursor').length>2000)throw Error();last=JSON.parse(atob(q.get('cursor')));if(last.signature!==signature||!Number.isFinite(last.key)||!/^\d{5,30}$/.test(last.id))throw Error();}catch{fail(400,'invalid_cursor');}}
  const sql=`WITH totals AS (
    SELECT m.user_id,COUNT(*) games,
      SUM(CASE WHEN outcome='win' THEN 1 ELSE 0 END) wins,
      SUM(CASE WHEN outcome='loss' THEN 1 ELSE 0 END) losses,
      SUM(CASE WHEN outcome='draw' THEN 1 ELSE 0 END) draws,
      SUM(CASE WHEN first_player=0 THEN 1 ELSE 0 END) human_starts,
      SUM(CASE WHEN first_player=1 THEN 1 ELSE 0 END) jev_starts,
      SUM(CASE WHEN first_player=0 THEN CASE outcome WHEN 'win' THEN 1.0 WHEN 'draw' THEN 0.5 ELSE 0.0 END ELSE 0.0 END) points0,
      SUM(CASE WHEN first_player=1 THEN CASE outcome WHEN 'win' THEN 1.0 WHEN 'draw' THEN 0.5 ELSE 0.0 END ELSE 0.0 END) points1
    FROM matches m WHERE ${where} GROUP BY m.user_id
  ), scored AS (
    SELECT *,CASE WHEN human_starts>=10 AND jev_starts>=10 THEN 1 ELSE 0 END eligible,
      CASE WHEN human_starts>0 AND jev_starts>0 THEN 0.5*(points0/human_starts+points1/jev_starts) ELSE NULL END score_rate
    FROM totals
  ), ranked AS (
    SELECT *,CASE WHEN eligible=1 THEN DENSE_RANK() OVER (ORDER BY eligible DESC,score_rate DESC) ELSE NULL END rank,
      CASE WHEN eligible=1 THEN score_rate ELSE -1 END sort_key FROM scored
  ) SELECT r.*,u.display_name FROM ranked r JOIN users u ON r.user_id=u.discord_id
  ${last?'WHERE (sort_key<? OR (sort_key=? AND user_id>?))':''}
  ORDER BY sort_key DESC,user_id ASC LIMIT 26`;
  if(last)args.push(last.key,last.key,last.id);
  const rows=await all(env,sql,...args),more=rows.length>25;rows.splice(25);
  const tail=rows.at(-1),nextCursor=more?btoa(JSON.stringify({signature,key:tail.sort_key,id:tail.user_id})):null;
  // Discord user IDs are needed for the opaque cursor only, not exposed as columns.
  return json({scope,difficulty,period,poolId:pool,minimumPerSeat:10,rows:rows.map(({user_id,sort_key,points0,points1,...r})=>r),nextCursor,ranking:'Seat-balanced match score rate; equal rates share rank.'});
}
export async function personalHistory(env,session){
  const rows=await all(env,'SELECT id,status,ranked,verified,outcome,first_player,created_at,pool_id,record_json FROM matches WHERE owner_key=? ORDER BY created_at DESC LIMIT 100',session.ownerKey);
  let currentStreak=0,bestStreak=0,run=0;
  for(const r of [...rows].reverse()){if(r.outcome==='win')run++;else if(r.outcome)run=0;bestStreak=Math.max(bestStreak,run);}currentStreak=run;
  return json({limit:100,currentStreak,bestStreak,matches:rows.map(({record_json,...r})=>{const m=JSON.parse(record_json);return {...r,difficulty:m.difficulty,mode:m.mode,score:{human:m.state.boxes.filter(b=>b===0).length,jev:m.state.boxes.filter(b=>b===1).length}};}),note:'Streaks cover the returned most recent 100 matches and include practice. Official rankings remain pool-specific.'});
}
