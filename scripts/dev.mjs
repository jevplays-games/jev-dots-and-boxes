import http from 'node:http';
import {readFile,mkdir,stat} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SQLiteD1} from './sqlite-adapter.mjs';
import worker from '../src/worker.js';
const root=resolve(fileURLToPath(new URL('..',import.meta.url))),assets=resolve(root,'public');
try{process.loadEnvFile(resolve(root,'.env'));}catch(error){if(error.code!=='ENOENT')throw error;}
const port=Number(process.env.PORT??8787),origin=process.env.APP_ORIGIN??`http://127.0.0.1:${port}`;
if(!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))throw Error('The development server binds only to localhost. Use Workers for public hosting.');
await mkdir(resolve(root,'.data'),{recursive:true});const DB=new SQLiteD1(process.env.DB_PATH??resolve(root,'.data/game.sqlite'));
DB.exec(await readFile(resolve(root,'migrations/0001_initial.sql'),'utf8'));
const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.json':'application/json'};
const env={...process.env,APP_ORIGIN:origin,DEV_MODE:'true',DB,ASSETS:{async fetch(request){
  let pathname;try{pathname=decodeURIComponent(new URL(request.url).pathname);}catch{return new Response('Bad path',{status:400});}
  const path=resolve(assets,'.'+(pathname==='/'?'/index.html':pathname));
  if(!path.startsWith(assets+sep))return new Response('Forbidden',{status:403});
  try{if(!(await stat(path)).isFile())throw Error();return new Response(await readFile(path),{headers:{'Content-Type':mime[extname(path)]??'application/octet-stream'}});}catch{return new Response('Not found',{status:404});}
}}};
const server=http.createServer(async(req,res)=>{
  try{
    const chunks=[];let bytes=0;for await(const c of req){bytes+=c.length;if(bytes>1048576){res.writeHead(413);res.end();return;}chunks.push(c);}
    const request=new Request(new URL(req.url,origin),{method:req.method,headers:req.headers,...(['GET','HEAD'].includes(req.method)?{}:{body:Buffer.concat(chunks)})});
    const jobs=[],response=await worker.fetch(request,env,{waitUntil:p=>jobs.push(p)});res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));await Promise.allSettled(jobs);
  }catch{res.writeHead(500,{'Content-Type':'text/plain'});res.end('Development server error.');}
});
server.listen(port,'127.0.0.1',()=>console.log(`Dots and Boxes: ${origin}\nOpponent: ${env.TYPESAFE_API_KEY?'JEV available':'local practice (no API key)'}\nDatabase: .data/game.sqlite`));
const cleanup=setInterval(()=>worker.scheduled({},env,{}).catch(()=>{}),3600000);cleanup.unref();
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{clearInterval(cleanup);server.close(()=>{DB.close();process.exit(0);});});
