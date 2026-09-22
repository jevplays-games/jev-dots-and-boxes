// Registers /play without a Discord runtime library. Never stores the bot token.
try{process.loadEnvFile();}catch(e){if(e.code!=='ENOENT')throw e;}
const {DISCORD_CLIENT_ID:id,DISCORD_BOT_TOKEN:token}=process.env;
if(!id||!token)throw Error('Set DISCORD_CLIENT_ID and DISCORD_BOT_TOKEN for this command only.');
const response=await fetch(`https://discord.com/api/v10/applications/${id}/commands`,{method:'POST',headers:{Authorization:`Bot ${token}`,'Content-Type':'application/json'},body:JSON.stringify({name:'play',description:'Play Dots and Boxes against JEV',type:1,integration_types:[0],contexts:[0]})});
if(!response.ok)throw Error(`Discord registration failed: HTTP ${response.status}`);
const result=await response.json();console.log(`Registered /play (${result.id}).`);
