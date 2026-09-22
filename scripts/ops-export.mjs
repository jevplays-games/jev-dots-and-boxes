/** Local administrator export. Does not export user records, sessions or credentials. */
import {mkdir,writeFile} from 'node:fs/promises';import {resolve} from 'node:path';
import {SQLiteD1} from './sqlite-adapter.mjs';import {csv,statistics} from '../public/analytics.js';
const [dbPath='.data/game.sqlite',out='operations-export']=process.argv.slice(2),db=new SQLiteD1(dbPath);
try{
  const {results}=await db.prepare('SELECT id,utc,type,data_json FROM operational_events ORDER BY utc,id').all();
  const rows=results.map(({data_json,...r})=>({...r,...JSON.parse(data_json)})),byRoute={};
  for(const r of rows.filter(r=>r.type==='http_request')){const key=`${r.method} ${r.route}`;byRoute[key]??=[];byRoute[key].push(r);}
  const summary=Object.entries(byRoute).map(([route,data])=>({route,requests:data.length,failures:data.filter(r=>r.status>=400).length,serverErrors:data.filter(r=>r.status>=500).length,rateLimits:data.filter(r=>r.status===429).length,...statistics(data.map(r=>r.latencyMs))}));
  await mkdir(out,{recursive:true});await writeFile(resolve(out,'operations.jsonl'),rows.map(r=>JSON.stringify(r)).join('\n'));await writeFile(resolve(out,'operations.csv'),csv(rows));await writeFile(resolve(out,'route-summary.json'),JSON.stringify(summary,null,2));console.log(`Exported ${rows.length} operational events to ${resolve(out)}`);
}finally{db.close();}
