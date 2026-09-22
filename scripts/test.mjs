/** Expand test paths in Node, rather than relying on POSIX shell glob behavior. */
import {readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const files=readdirSync(new URL('../tests/',import.meta.url)).filter(name=>name.endsWith('.test.mjs')).sort().map(name=>fileURLToPath(new URL('../tests/'+name,import.meta.url)));
const result=spawnSync(process.execPath,['--test',...files],{stdio:'inherit'});
if(result.error){console.error(result.error.message);process.exitCode=1;}else{process.exitCode=result.status??1;}
