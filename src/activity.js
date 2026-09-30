// Discord Activity support. Discord loads the game in an iframe on <application id>.discordsays.com, where a
// SameSite cookie is not sent, so the game signs the player in through the Embedded App SDK and then keeps a
// bearer session token in memory. Nothing here changes the normal browser sign-in.
import {fail,json,body,quota,operation} from './common.js';
import {activityOrigin,discordIdentity,upsertDiscordUser,issueSession} from './auth.js';

export function activityConfig(env){
  if(!env.DISCORD_CLIENT_ID||!env.DISCORD_CLIENT_SECRET)fail(503,'discord_not_configured');
  return json({clientId:env.DISCORD_CLIENT_ID});
}
export async function createActivitySession(request,env){
  if(!env.DISCORD_CLIENT_ID||!env.DISCORD_CLIENT_SECRET)fail(503,'discord_not_configured');
  const origin=request.headers.get('origin');
  if(!origin||(origin!==activityOrigin(env)&&origin!==env.APP_ORIGIN))fail(403,'origin_rejected');
  await quota(env,'activity-session-global',Number(env.MAX_SESSIONS_PER_HOUR??300));
  const {code}=await body(request,4096);
  if(typeof code!=='string'||!code||code.length>=2048)fail(400,'invalid_code');
  // An SDK authorization code is exchanged without a redirect URI.
  const {identity,accessToken}=await discordIdentity(env,code,null),user=await upsertDiscordUser(env,identity);
  const s=await issueSession(env,identity.id);
  await operation(env,'activity_session_created',{success:true});
  // The Discord access token is returned once so the SDK can authenticate; it is never stored or logged.
  return json({token:s.raw,csrf:s.csrf,accessToken,user:{discord_id:user.discord_id,display_name:user.display_name}});
}
