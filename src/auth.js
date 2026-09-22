import {first,run,fail,token,validToken,json,cookie,cookieName,cookies,body,quota,withTimeout,operation} from './common.js';
import {sha256} from '../public/analytics.js';
export async function getSession(request,env,required=false){
  const raw=cookies(request)[cookieName(env)];let row=null;
  if(validToken(raw))row=await first(env,'SELECT * FROM sessions WHERE token_hash=? AND expires_at>?',await sha256(raw),Date.now());
  if(!row){if(required)fail(401,'session_required');return null;}return {...row,raw,csrf:await sha256(`csrf:${raw}`),ownerKey:row.user_id?`user:${row.user_id}`:`guest:${row.token_hash}`};
}
export async function issueSession(env,userId=null,context=null,pending=null){
  const raw=token(),csrf=await sha256(`csrf:${raw}`),hash=await sha256(raw),now=Date.now();
  await run(env,'INSERT INTO sessions(token_hash,user_id,csrf_hash,context_json,pending_launch_hash,created_at,expires_at) VALUES(?,?,?,?,?,?,?)',hash,userId,await sha256(csrf),context?JSON.stringify(context):null,pending,now,now+604800000);
  return {raw,token_hash:hash,user_id:userId,csrf,context_json:context?JSON.stringify(context):null,pending_launch_hash:pending,ownerKey:userId?`user:${userId}`:`guest:${hash}`};
}
export async function sessionResponse(request,env){
  let session=await getSession(request,env);const fresh=!session;
  if(!session){await quota(env,'session-global',Number(env.MAX_SESSIONS_PER_HOUR??300));session=await issueSession(env);}
  const user=session.user_id?await first(env,'SELECT discord_id,display_name,avatar_ref FROM users WHERE discord_id=?',session.user_id):null;
  const context=session.context_json?JSON.parse(session.context_json):null;
  const active=await first(env,"SELECT id FROM matches WHERE owner_key=? AND status='active'",session.ownerKey);
  return json({user,csrf:session.csrf,context:context&&context.expiresAt>Date.now()?context:null,activeMatchId:active?.id??null,
    capabilities:{jev:!!env.TYPESAFE_API_KEY,discord:!!env.DISCORD_CLIENT_ID&&!!env.DISCORD_CLIENT_SECRET,ranked:!!env.TYPESAFE_API_KEY&&!!env.DISCORD_CLIENT_ID,model:env.JEV_MODEL??'jev-1.13.0'}},200,fresh?{'Set-Cookie':cookie(env,session.raw)}:{});
}
export async function requireMutation(request,env){
  if(request.headers.get('origin')!==env.APP_ORIGIN)fail(403,'origin_rejected');
  const s=await getSession(request,env,true),csrf=request.headers.get('x-csrf-token');
  if(!validToken(csrf)||await sha256(csrf)!==s.csrf_hash)fail(403,'csrf_rejected');
  await quota(env,`request:${s.token_hash}`,600);return s;
}
export async function launchContext(env,hash,userId){
  const launch=await first(env,'SELECT * FROM discord_launches WHERE token_hash=? AND expires_at>?',hash,Date.now());
  if(!launch||launch.discord_user_id!==userId)fail(403,'invalid_launch','The launch is expired or belongs to another Discord account.');
  return {guildId:launch.guild_id,channelId:launch.channel_id,expiresAt:launch.expires_at,launchHash:hash};
}
export async function attachContext(request,env,s){
  if(!s.user_id)fail(401,'discord_required');const b=await body(request);
  if(!validToken(b.launch))fail(400,'invalid_launch');const hash=await sha256(b.launch),context=await launchContext(env,hash,s.user_id);
  await run(env,'UPDATE sessions SET context_json=?,pending_launch_hash=? WHERE token_hash=?',JSON.stringify(context),hash,s.token_hash);
  return json({context});
}
export async function oauthStart(request,env){
  if(!env.DISCORD_CLIENT_ID||!env.DISCORD_CLIENT_SECRET)fail(503,'discord_not_configured');
  let s=await getSession(request,env);const fresh=!s;if(!s)s=await issueSession(env);
  await quota(env,`oauth:${s.token_hash}`,20);
  const params=new URL(request.url).searchParams,launch=params.get('launch');
  if(launch&&!validToken(launch))fail(400,'invalid_launch');
  const state=token();await run(env,'INSERT INTO oauth_flows(state_hash,browser_binding_hash,pending_launch_hash,expires_at) VALUES(?,?,?,?)',await sha256(state),s.token_hash,launch?await sha256(launch):s.pending_launch_hash,Date.now()+600000);
  const target=new URL('https://discord.com/oauth2/authorize');target.search=new URLSearchParams({client_id:env.DISCORD_CLIENT_ID,response_type:'code',redirect_uri:`${env.APP_ORIGIN}/api/auth/discord/callback`,scope:'identify',state}).toString();
  return new Response(null,{status:302,headers:{Location:target.toString(),...(fresh?{'Set-Cookie':cookie(env,s.raw)}:{})}});
}
export async function oauthCallback(request,env){
  const q=new URL(request.url).searchParams,s=await getSession(request,env,true),state=q.get('state');
  if(!validToken(state))fail(403,'oauth_state_rejected');
  const flow=await first(env,'DELETE FROM oauth_flows WHERE state_hash=? AND browser_binding_hash=? AND expires_at>? RETURNING *',await sha256(state),s.token_hash,Date.now());
  if(!flow)fail(403,'oauth_state_rejected');
  if(q.has('error'))return new Response(null,{status:302,headers:{Location:'/?auth=cancelled'}});
  const code=q.get('code');if(!code||code.length>2048)fail(400,'oauth_code_missing');
  const fetcher=env.FETCH??fetch;
  const exchanged=await withTimeout('https://discord.com/api/v10/oauth2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:env.DISCORD_CLIENT_ID,client_secret:env.DISCORD_CLIENT_SECRET,grant_type:'authorization_code',code,redirect_uri:`${env.APP_ORIGIN}/api/auth/discord/callback`}).toString()},5000,fetcher);
  if(!exchanged.ok)fail(502,'oauth_exchange_failed');const credentials=await exchanged.json();
  if(typeof credentials.access_token!=='string')fail(502,'oauth_exchange_failed');
  const fetched=await withTimeout('https://discord.com/api/v10/users/@me',{headers:{Authorization:`Bearer ${credentials.access_token}`}},5000,fetcher);
  if(!fetched.ok)fail(502,'discord_identity_failed');const identity=await fetched.json();
  if(!/^\d{5,30}$/.test(identity.id))fail(502,'discord_identity_failed');
  const name=String(identity.global_name??identity.username??'Discord player').slice(0,100),now=Date.now();
  await run(env,'INSERT INTO users(discord_id,display_name,avatar_ref,created_at,last_seen_at) VALUES(?,?,?,?,?) ON CONFLICT(discord_id) DO UPDATE SET display_name=excluded.display_name,avatar_ref=excluded.avatar_ref,last_seen_at=excluded.last_seen_at',identity.id,name,typeof identity.avatar==='string'?identity.avatar:null,now,now);
  let context=null;if(flow.pending_launch_hash)context=await launchContext(env,flow.pending_launch_hash,identity.id);
  const next=await issueSession(env,identity.id,context,context?flow.pending_launch_hash:null);
  // An existing guest match stays guest-only; it is never promoted to ranked.
  await run(env,'DELETE FROM sessions WHERE token_hash=?',s.token_hash);
  await operation(env,'oauth_completed',{success:true});
  return new Response(null,{status:302,headers:{Location:'/', 'Set-Cookie':cookie(env,next.raw)}});
}
export async function logout(env,s){await run(env,'DELETE FROM sessions WHERE token_hash=?',s.token_hash);return json({ok:true},200,{'Set-Cookie':cookie(env,'',0)});}
