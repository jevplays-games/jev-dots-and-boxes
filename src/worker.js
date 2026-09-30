import {sessionResponse,getSession,requireMutation,oauthStart,oauthCallback,logout,attachContext} from './auth.js';
import {interaction} from './discord.js';
import {activityConfig,createActivitySession} from './activity.js';
import {createMatch,stepMatch,loadMatch,snapshot,matchExport,expireMatches} from './matches.js';
import {leaderboard,personalHistory} from './leaderboard.js';
import {json,body,fail,responseSecurity,operation,run,all,quota} from './common.js';
import {summarize,statistics} from '../public/analytics.js';
async function routes(request,env){
  const url=new URL(request.url),path=url.pathname;
  if(!env.APP_ORIGIN||url.origin!==env.APP_ORIGIN)fail(400,'origin_configuration_mismatch');
  if(!path.startsWith('/api/'))return env.ASSETS.fetch(request);
  if(!env.DB)fail(503,'database_not_configured');
  if(path==='/api/health'&&request.method==='GET')return json({ok:true,game:'dots-and-boxes',version:'1.0.0'});
  if(path==='/api/discord/interactions'&&request.method==='POST')return interaction(request,env);
  if(path==='/api/session'&&request.method==='GET')return sessionResponse(request,env);
  if(path==='/api/activity/config'&&request.method==='GET')return activityConfig(env);
  if(path==='/api/activity/session'&&request.method==='POST')return createActivitySession(request,env);
  if(path==='/api/auth/discord'&&request.method==='GET')return oauthStart(request,env);
  if(path==='/api/auth/discord/callback'&&request.method==='GET')return oauthCallback(request,env);
  const mutating=['POST','PUT','PATCH','DELETE'].includes(request.method),s=mutating?await requireMutation(request,env):await getSession(request,env);
  if(path==='/api/leaderboard'&&request.method==='GET')return leaderboard(request,env,s);
  if(!s)fail(401,'session_required');
  if(path==='/api/logout'&&request.method==='POST')return logout(env,s);
  if(path==='/api/session/context'&&request.method==='POST')return attachContext(request,env,s);
  if(path==='/api/matches'&&request.method==='POST')return createMatch(env,s,await body(request));
  if(path==='/api/history'&&request.method==='GET')return personalHistory(env,s);
  if(path==='/api/analytics'&&request.method==='GET'){
    const rows=await all(env,'SELECT record_json FROM matches WHERE owner_key=? ORDER BY created_at DESC LIMIT 100',s.ownerKey),summaries=rows.map(r=>summarize(JSON.parse(r.record_json)));
    return json({matches:summaries,total:summaries.length,limit:100,decisionLatencyMeansMs:statistics(summaries.map(x=>x.latencyMs.mean)),note:'Filtered to your own most recent 100 matches. Do not compare mixed opponent pools.'});
  }
  const match=path.match(/^\/api\/matches\/([a-f0-9-]{36})(?:\/(step|events|export|telemetry))?$/);
  if(match){
    const [,id,action]=match;
    if(action==='step'&&request.method==='POST')return stepMatch(env,s,id,await body(request));
    if(action==='export'&&request.method==='GET')return matchExport(env,s,id,url.searchParams.get('format')??'json');
    if(action==='telemetry'&&request.method==='POST'){
      // Explicitly opt-in, allowlisted, client-asserted data. Never affects rules or rankings.
      const {match:m}=await loadMatch(env,id,s),b=await body(request,8192);
      if(b.consent!==true||!Array.isArray(b.events)||b.events.length>20)fail(400,'invalid_telemetry');
      await quota(env,`telemetry:${s.token_hash}`,60);
      const allowed=new Set(['page_loaded','replay_opened','export_clicked','analysis_toggled','network_error','render_sample','visibility_changed']);
      const events=b.events.map(e=>{
        if(!allowed.has(e.type))fail(400,'invalid_telemetry_type');
        return {type:e.type,durationMs:Number.isFinite(e.durationMs)?Math.max(0,Math.min(60000,e.durationMs)):null};
      });
      await operation(env,'client_telemetry',{matchId:m.id,trust:'client_asserted',events});return json({accepted:events.length});
    }
    if(request.method==='GET'){
      await expireMatches(env,s.ownerKey);const {match:m}=await loadMatch(env,id,s);
      if(!action)return json(snapshot(m));
      if(action==='events'){
        const after=Number(url.searchParams.get('after')??0);if(!Number.isInteger(after)||after<0)fail(400,'invalid_event_cursor');
        const events=m.events.slice(after,after+100);return json({events,nextAfter:events.at(-1)?.sequence??after,hasMore:after+events.length<m.events.length,total:m.events.length});
      }
    }
  }
  fail(404,'not_found');
}
export default {
  async fetch(request,env,ctx={waitUntil:promise=>promise.catch(()=>{})}){
    const started=performance.now();let response,errorCode=null;
    try{response=await routes(request,env);}catch(error){errorCode=error.code??'internal_error';response=json({error:errorCode,message:error.status?error.message:'An internal error occurred. No result was accepted.'},error.status??500);}
    if(new URL(request.url).pathname.startsWith('/api/')&&env.DB){
      // No query strings, IPs, names, cookies, request text or provider keys.
      const rawPath=new URL(request.url).pathname;
      const known=new Set(['/api/health','/api/session','/api/auth/discord','/api/auth/discord/callback','/api/activity/config','/api/activity/session','/api/discord/interactions','/api/leaderboard','/api/logout','/api/session/context','/api/matches','/api/history','/api/analytics']);
      const route=known.has(rawPath)?rawPath:/^\/api\/matches\/[a-f0-9-]{36}(?:\/(step|events|export|telemetry))?$/.test(rawPath)?rawPath.replace(/[a-f0-9-]{36}/,':match'):'/api/unknown';
      ctx.waitUntil(operation(env,'http_request',{route,method:request.method,status:response.status,latencyMs:performance.now()-started,errorCode}).catch(()=>{}));
    }
    return responseSecurity(response,new URL(request.url));
  },
  async scheduled(controller,env,ctx){
    await expireMatches(env);
    const now=Date.now();await env.DB.batch([
      env.DB.prepare('DELETE FROM sessions WHERE expires_at<?').bind(now),
      env.DB.prepare('DELETE FROM oauth_flows WHERE expires_at<?').bind(now),
      env.DB.prepare('DELETE FROM quotas WHERE expires_at<?').bind(now),
      env.DB.prepare('DELETE FROM operational_events WHERE utc<?').bind(new Date(now-30*86400000).toISOString()),
      env.DB.prepare("DELETE FROM matches WHERE ranked=0 AND created_at<? AND status<>'active'").bind(now-Number(env.PRACTICE_RETENTION_DAYS??90)*86400000),
      env.DB.prepare('DELETE FROM discord_launches WHERE expires_at<? AND token_hash NOT IN(SELECT launch_hash FROM matches WHERE launch_hash IS NOT NULL)').bind(now)
    ]);
  }
};
