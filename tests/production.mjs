import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
const dir=await mkdtemp(join(tmpdir(),'lecture-production-'));
const base='http://127.0.0.1:43187';
let child;
try{
 try{await fetch(base+'/api/health',{signal:AbortSignal.timeout(500)});throw new Error('Stop the running app before running the production smoke test.');}catch(e){if(e.message.startsWith('Stop the running'))throw e;}
 child=spawn(process.execPath,['dist/server/index.js'],{env:{...process.env,LECTURE_DATA_DIR:dir},stdio:['ignore','pipe','pipe']});
 let output='';child.stderr.on('data',b=>output+=b);child.stdout.on('data',b=>output+=b);
 let ready=false;
 for(let n=0;n<100;n++){try{const r=await fetch(base+'/api/health',{signal:AbortSignal.timeout(500)});if(r.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}
 assert(ready,`Production server did not start: ${output}`);
 const html=await(await fetch(base)).text();assert(html.includes('Lecture Transcriber'));assert(html.includes('/assets/'));
 const boot=await(await fetch(base+'/api/bootstrap')).json();assert.equal(boot.jobs.length,0);assert.equal(boot.ffmpegAvailable,true);assert.equal(typeof boot.keyConfigured,'boolean');assert.equal(boot.dataDir,dir);
 const duplicate=spawn(process.execPath,['dist/server/index.js'],{env:{...process.env,LECTURE_DATA_DIR:dir},stdio:'ignore'});
 const [exit]=await once(duplicate,'exit');assert.equal(exit,1,'A duplicate backend must exit without opening the store.');
 const live=await(await fetch(base+'/api/health')).json();assert.equal(live.app,'lecture-transcriber');
 const stopped=once(child,'exit');const response=await fetch(base+'/api/shutdown',{method:'POST',headers:{'X-CSRF-Token':boot.csrfToken,Origin:base}});assert.equal(response.status,200);
 const [code]=await stopped;assert.equal(code,0);
 console.log('Production smoke passed: built assets, FFmpeg readiness, empty private data, exclusive loopback port, duplicate-instance rejection, graceful CSRF shutdown.');
}finally{if(child&&child.exitCode===null){const done=once(child,'exit');child.kill('SIGTERM');await done;}await rm(dir,{recursive:true,force:true});}
