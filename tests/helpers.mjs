import {readFileSync} from 'node:fs';
import {SQLiteD1} from '../scripts/sqlite-adapter.mjs';
import worker from '../src/worker.js';
import {issueSession} from '../src/auth.js';
export function mockProvider(url,init){
  const request=JSON.parse(init.body),ids=Object.keys(request.questions.move.criteria),choice=ids.sort((a,b)=>Number(a)-Number(b))[0];
  return Promise.resolve(new Response(JSON.stringify({model:request.model,answers:{move:{type:'choice',choice,probabilities:Object.fromEntries(ids.map(id=>[id,id===choice?1:0])),confidence:1}},usage:{input_tokens:120,output_tokens:30}}),{headers:{'Content-Type':'application/json'}}));
}
export function environment(extra={}){
  const DB=new SQLiteD1();DB.exec(readFileSync(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8'));
  return {DB,APP_ORIGIN:'http://127.0.0.1:8787',DEV_MODE:'true',TYPESAFE_API_KEY:'test-not-a-real-key',JEV_MODEL:'jev-1.13.0',FETCH:mockProvider,ASSETS:{fetch:()=>new Response('test asset')},MAX_PROVIDER_CALLS_PER_DAY:'100000',...extra};
}
export class Client{
  constructor(env){this.env=env;this.cookie='';this.csrf='';}
  async request(path,{method='GET',data,headers={}}={}){
    const h={cookie:this.cookie,...headers};if(method!=='GET'&&data!==undefined){h.origin=this.env.APP_ORIGIN;h['x-csrf-token']=this.csrf;h['content-type']='application/json';Object.assign(h,headers);}
    const jobs=[];const response=await worker.fetch(new Request(this.env.APP_ORIGIN+path,{method,headers:h,...(data!==undefined?{body:JSON.stringify(data)}:{})}),this.env,{waitUntil:p=>jobs.push(p)});await Promise.all(jobs);
    if(response.headers.get('set-cookie'))this.cookie=response.headers.get('set-cookie').split(';')[0];
    let body;const text=await response.text();try{body=JSON.parse(text);}catch{body=text;}if(body?.csrf)this.csrf=body.csrf;
    return {status:response.status,body,headers:response.headers};
  }
  async init(){return this.request('/api/session');}
  async user(id='123456789012345678',name='Test Player'){
    await this.env.DB.prepare('INSERT OR REPLACE INTO users(discord_id,display_name,created_at,last_seen_at) VALUES(?,?,?,?)').bind(id,name,Date.now(),Date.now()).run();
    const s=await issueSession(this.env,id);this.cookie=`dots_session=${s.raw}`;this.csrf=s.csrf;return s;
  }
  async create(data={}){return this.request('/api/matches',{method:'POST',data:{difficulty:'easy',mode:'local',...data}});}
  async step(m,operation,edgeId,requestId=crypto.randomUUID()){
    return this.request(`/api/matches/${m.id}/step`,{method:'POST',data:{operation,expectedRevision:m.revision,edgeId,requestId}});
  }
}
