// Registers /play without a Discord runtime library. Uses client credentials (or an optional bot token); stores no token.
try{process.loadEnvFile();}catch(e){if(e.code!=='ENOENT')throw e;}
const {DISCORD_CLIENT_ID:id,DISCORD_CLIENT_SECRET:secret,DISCORD_BOT_TOKEN:botToken}=process.env;
if(!id||(!botToken&&!secret))throw Error('Set DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET (or DISCORD_BOT_TOKEN) for this command only.');
// Prefer client credentials (no bot token needed); fall back to a bot token if one is set.
let authorization=`Bot ${botToken}`;
if(!botToken){
  const grant=await fetch('https://discord.com/api/v10/oauth2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'client_credentials',scope:'applications.commands.update',client_id:id,client_secret:secret})});
  if(!grant.ok)throw Error(`Discord token request failed: HTTP ${grant.status}`);
  const {access_token}=await grant.json();
  if(typeof access_token!=='string')throw Error('Discord returned no access token.');
  authorization=`Bearer ${access_token}`;
}
const response=await fetch(`https://discord.com/api/v10/applications/${id}/commands`,{method:'POST',headers:{Authorization:authorization,'Content-Type':'application/json'},body:JSON.stringify({name:'play',description:'Play Dots and Boxes against JEV',type:1,integration_types:[0],contexts:[0]})});
if(!response.ok)throw Error(`Discord registration failed: HTTP ${response.status}`);
const result=await response.json();console.log(`Registered /play (${result.id}).`);
