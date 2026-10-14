import {readFile} from 'node:fs/promises';
import {auditMatch} from '../public/analytics.js';
import {replay,REPLAY_FORMATS} from '../public/games/box-score/rules.js';
const file=process.argv[2];if(!file){console.error('Usage: npm run audit -- path/to/full-match.json');process.exit(2);}
try{const value=JSON.parse(await readFile(file,'utf8'));if(REPLAY_FORMATS.includes(value.format)){const r=replay(value);console.log(JSON.stringify({ok:true,type:'rules-only replay',score:r.score,outcome:r.outcome,warning:'A compact replay has no authenticated provider provenance.'},null,2));}else{const result=await auditMatch(value);console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=1;}}catch(error){console.error(error.message);process.exitCode=1;}
