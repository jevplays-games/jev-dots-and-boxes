import {readFile,writeFile,mkdir} from 'node:fs/promises';import {resolve} from 'node:path';
import {auditMatch,summarize,exportTables,csv} from '../public/analytics.js';
const [file,out='analytics-export']=process.argv.slice(2);if(!file){console.error('Usage: npm run export -- full-match.json output-directory');process.exit(2);}
try{
  const match=JSON.parse(await readFile(file,'utf8')),audit=await auditMatch(match);if(!audit.ok)throw Error('Refusing export of an invalid journal: '+audit.errors.join('; '));
  await mkdir(out,{recursive:true});await writeFile(resolve(out,'summary.json'),JSON.stringify(summarize(match),null,2));await writeFile(resolve(out,'audit.json'),JSON.stringify(audit,null,2));
  await writeFile(resolve(out,'manifest.json'),JSON.stringify(match.manifest??{},null,2));
  for(const [name,rows] of Object.entries(exportTables(match))){await writeFile(resolve(out,`${name}.csv`),csv(rows));await writeFile(resolve(out,`${name}.jsonl`),rows.map(r=>JSON.stringify(r)).join('\n')+(rows.length?'\n':''));}
  await writeFile(resolve(out,'journal.jsonl'),match.events.map(e=>JSON.stringify(e)).join('\n')+'\n');console.log(`Exported verified analytics to ${resolve(out)}`);
}catch(error){console.error(error.message);process.exitCode=1;}
