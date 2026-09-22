import {limitedText,fail,json,token,run,first} from './common.js';
import {sha256} from '../public/analytics.js';
export async function verifyDiscordSignature(request,text,publicKey,now=Date.now()){
  const stamp=request.headers.get('x-signature-timestamp'),signature=request.headers.get('x-signature-ed25519');
  if(!/^\d+$/.test(stamp??'')||Math.abs(now-Number(stamp)*1000)>300000||!/^[a-f0-9]{128}$/i.test(signature??'')||!/^[a-f0-9]{64}$/i.test(publicKey??''))return false;
  const bytes=s=>Uint8Array.from(s.match(/../g),h=>parseInt(h,16));
  try{const key=await crypto.subtle.importKey('raw',bytes(publicKey),{name:'Ed25519'},false,['verify']);return await crypto.subtle.verify('Ed25519',key,bytes(signature),new TextEncoder().encode(stamp+text));}catch{return false;}
}
export async function interaction(request,env){
  const text=await limitedText(request,65536);
  if(!await verifyDiscordSignature(request,text,env.DISCORD_PUBLIC_KEY))fail(401,'discord_signature_rejected');
  let p;try{p=JSON.parse(text);}catch{fail(400,'invalid_interaction');}
  if(p.application_id!==env.DISCORD_CLIENT_ID)fail(403,'wrong_application');
  if(p.type===1)return json({type:1});
  const channel=p.channel_id??p.channel?.id;
  if(p.type!==2||p.data?.name!=='play'||!p.guild_id||!channel||!p.member?.user?.id||p.channel?.type!==0)return json({type:4,data:{content:'Use /play in an ordinary server text channel.',flags:64}});
  if([p.id,p.guild_id,channel,p.member.user.id].some(id=>!/^\d{5,30}$/.test(id)))fail(400,'invalid_discord_ids');
  const previous=await first(env,'SELECT interaction_id FROM discord_launches WHERE interaction_id=?',p.id);
  if(previous)return json({type:4,data:{content:'This interaction was already handled. Invoke /play again for a new link.',flags:64}});
  const launch=token();
  await run(env,'INSERT INTO discord_launches(token_hash,interaction_id,discord_user_id,guild_id,channel_id,expires_at) VALUES(?,?,?,?,?,?)',await sha256(launch),p.id,p.member.user.id,p.guild_id,channel,Date.now()+600000);
  return json({type:4,data:{content:'Play Dots and Boxes against JEV. This personal link expires in 10 minutes.',flags:64,components:[{type:1,components:[{type:2,style:5,label:'Play Dots and Boxes',url:`${env.APP_ORIGIN}/?launch=${launch}`}]}]}});
}
