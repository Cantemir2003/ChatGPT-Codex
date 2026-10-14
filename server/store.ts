import {mkdirSync,readFileSync,writeFileSync,renameSync,openSync,closeSync,fsyncSync,readdirSync,existsSync,rmSync,lstatSync} from 'node:fs';
import {join,resolve,relative,isAbsolute,sep,basename} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DEFAULTS} from '../shared/config.js';
import type {Job,Preferences,Attempt} from '../shared/types.js';
import {AppError,validatePreferences} from './validation.js';
export function atomicJson(path:string,value:unknown){const tmp=path+'.'+randomUUID()+'.tmp';writeFileSync(tmp,JSON.stringify(value,null,2),{mode:0o600,flag:'wx'});const fd=openSync(tmp,'r');try{fsyncSync(fd);}finally{closeSync(fd);}renameSync(tmp,path);}
export function atomicText(path:string,value:string){const tmp=path+'.'+randomUUID()+'.tmp';writeFileSync(tmp,value,{mode:0o600,encoding:'utf8',flag:'wx'});renameSync(tmp,path);}

const unsafeManifest=()=>new AppError('A saved lecture contains an invalid or unsafe local file reference. Its files have been preserved. Restore its manifest from a trusted backup.',500);

/** Reject links inside the private data root, including intermediate directories. */
function assertLocalPath(root:string,path:string,kind:'file'|'directory'){
 const suffix=relative(root,path);
 if(suffix==='..'||suffix.startsWith(`..${sep}`)||isAbsolute(suffix))throw unsafeManifest();
 const paths=[root];
 if(suffix){let current=root;for(const part of suffix.split(sep)){current=join(current,part);paths.push(current);}}
 for(let index=0;index<paths.length;index++){
  let info;try{info=lstatSync(paths[index]);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw unsafeManifest();}
  if(info.isSymbolicLink())throw unsafeManifest();
  const final=index===paths.length-1;
  if(final&&kind==='file'?!info.isFile():!info.isDirectory())throw unsafeManifest();
 }
}
export class Store {
 jobs=new Map<string,Job>(); preferences:Preferences=structuredClone(DEFAULTS);
 ledger:Record<string,{estimatedUsd:number;outcome:Attempt['outcome']}>={};
 constructor(public dataDir:string){
  this.dataDir=resolve(dataDir);dataDir=this.dataDir;
  for(const dir of [dataDir,join(dataDir,'jobs'),join(dataDir,'uploads')])assertLocalPath(dataDir,dir,'directory');
  mkdirSync(join(dataDir,'jobs'),{recursive:true,mode:0o700});mkdirSync(join(dataDir,'uploads'),{recursive:true,mode:0o700});
  for(const file of ['preferences.json','usage.json'])assertLocalPath(dataDir,join(dataDir,file),'file');
  if(existsSync(join(dataDir,'preferences.json')))this.preferences=validatePreferences(JSON.parse(readFileSync(join(dataDir,'preferences.json'),'utf8')));
  if(existsSync(join(dataDir,'usage.json')))this.ledger=JSON.parse(readFileSync(join(dataDir,'usage.json'),'utf8'));
  for(const entry of readdirSync(join(dataDir,'jobs'),{withFileTypes:true})){
   if(/^[a-f0-9-]{36}$/.test(entry.name)&&entry.isSymbolicLink())throw unsafeManifest();
   if(!entry.isDirectory()||!/^[a-f0-9-]{36}$/.test(entry.name))continue;
   const path=join(dataDir,'jobs',entry.name,'manifest.json');assertLocalPath(dataDir,path,'file');if(!existsSync(path))continue;
   // Do not overwrite malformed manifests: fail visibly so the original remains recoverable.
   let job:Job;try{job=JSON.parse(readFileSync(path,'utf8'));}catch{throw new AppError('A saved lecture manifest could not be read. Restore it from a backup in your local data folder.',500);}
   if(job.id!==entry.name||!Array.isArray(job.chunks))throw new AppError('A saved lecture has an invalid manifest. Its files have been preserved.',500);
   this.assertOwned(job);
   for(const chunk of job.chunks){
    const raw=join(this.jobDir(job.id),'responses',chunk.id+'.json');
    if(chunk.status!=='complete'&&existsSync(raw)){const saved=JSON.parse(readFileSync(raw,'utf8'));if(typeof saved.text==='string'){chunk.text=saved.text;chunk.status='complete';const last=chunk.attempts.at(-1);if(last){last.outcome='success';last.endedAt=new Date().toISOString();}}}
    for(let i=0;i<chunk.attempts.length;i++){const a=chunk.attempts[i];if(a.outcome==='pending')a.outcome='uncertain';this.ledger[`${job.id}/${chunk.id}/${i}`]={estimatedUsd:a.estimatedUsd,outcome:a.outcome};}
   }
   if(['queued','preparing','uploading','transcribing','retrying'].includes(job.status)){job.status='paused';job.error='The app stopped before this lecture finished. Resume to continue. An interrupted request may still have been charged.';}
   if(job.chunks.length&&job.chunks.every(c=>c.status==='complete')){job.status='complete';job.partialText='';job.error=undefined;}
   job.text=assemble(job);this.jobs.set(job.id,job);this.save(job);
  }
  atomicJson(join(dataDir,'usage.json'),this.ledger);
 }
 jobDir(id:string){if(!/^[a-f0-9-]{36}$/.test(id))throw new AppError('Lecture not found.',404);return join(this.dataDir,'jobs',id);}
 assertOwned(job:Job){
  if(!job||typeof job.id!=='string'||!Array.isArray(job.chunks))throw unsafeManifest();
  const directory=this.jobDir(job.id);
  assertLocalPath(this.dataDir,directory,'directory');
  if(typeof job.sourceFile!=='string'||!/^source\.[a-z0-9]{1,6}$/.test(basename(job.sourceFile))||job.sourceFile!==join(directory,basename(job.sourceFile)))throw unsafeManifest();
  assertLocalPath(this.dataDir,job.sourceFile,'file');
  assertLocalPath(this.dataDir,join(directory,'audio'),'directory');
  assertLocalPath(this.dataDir,join(directory,'responses'),'directory');
  const ids=new Set<string>();const indices=new Set<number>();
  for(const chunk of job.chunks){
   if(!chunk||typeof chunk.id!=='string'||!/^chunk-\d{6}$/.test(chunk.id)||ids.has(chunk.id)||!Number.isInteger(chunk.index)||chunk.index<0||indices.has(chunk.index)||!Array.isArray(chunk.attempts))throw unsafeManifest();
   ids.add(chunk.id);indices.add(chunk.index);
   const extensions=['wav','m4a','mp3','webm'];
   if(typeof chunk.file!=='string'||!extensions.some(extension=>chunk.file===join(directory,'audio',`${chunk.id}.${extension}`)))throw unsafeManifest();
   assertLocalPath(this.dataDir,chunk.file,'file');
   assertLocalPath(this.dataDir,join(directory,'responses',chunk.id+'.json'),'file');
  }
 }
 get(id:string){const job=this.jobs.get(id);if(!job)throw new AppError('Lecture not found.',404);return job;}
 list(){return [...this.jobs.values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt));}
 save(job:Job){mkdirSync(this.jobDir(job.id),{recursive:true,mode:0o700});job.updatedAt=new Date().toISOString();job.text=assemble(job);this.jobs.set(job.id,job);atomicJson(join(this.jobDir(job.id),'manifest.json'),job);atomicText(join(this.jobDir(job.id),'transcript.txt'),job.text);}
 saveResponse(job:Job,chunkId:string,response:unknown){this.assertOwned(job);if(!job.chunks.some(chunk=>chunk.id===chunkId))throw unsafeManifest();const dir=join(this.jobDir(job.id),'responses');mkdirSync(dir,{recursive:true,mode:0o700});atomicJson(join(dir,chunkId+'.json'),response);}
 record(job:Job,chunkId:string,index:number,attempt:Attempt){this.ledger[`${job.id}/${chunkId}/${index}`]={estimatedUsd:attempt.estimatedUsd,outcome:attempt.outcome};atomicJson(join(this.dataDir,'usage.json'),this.ledger);}
 usage(){const rows=Object.values(this.ledger);return {estimatedUsd:rows.reduce((s,r)=>s+r.estimatedUsd,0),uncertainRequests:rows.filter(r=>r.outcome==='uncertain'||r.outcome==='pending').length,requests:rows.length};}
 savePreferences(prefs:unknown){this.preferences=validatePreferences(prefs);atomicJson(join(this.dataDir,'preferences.json'),this.preferences);return this.preferences;}
 remove(id:string){this.assertOwned(this.get(id));rmSync(this.jobDir(id),{recursive:true,force:true});this.jobs.delete(id);}
}
export function assemble(job:Pick<Job,'chunks'>){return [...job.chunks].sort((a,b)=>a.index-b.index).filter(c=>c.status==='complete').map(c=>c.text??'').join('\n\n');}
