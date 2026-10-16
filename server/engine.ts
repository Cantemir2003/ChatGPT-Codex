import {randomUUID} from 'node:crypto';
import {mkdir,rename,rm,stat} from 'node:fs/promises';
import {join,basename,extname} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import type {Job,TranscriptionSettings,AppSettings,AudioInfo,Chunk} from '../shared/types.js';
import {estimateCost} from '../shared/config.js';
import {applyResponse,isChunkFinished,refreshReview} from '../shared/review.js';
import {Store} from './store.js';
import {inspectAudio,prepareChunks} from './audio.js';
import {analyzeSpeech,VAD_MODEL,VAD_VERSION} from './vad.js';
import {AppError,validateApp,validateTranscription} from './validation.js';
import {transcribe,classifyError,type Transcriber,type TranscribeResult} from './transcribe.js';
interface EngineOptions {key:()=>Promise<string|null>;transcriber?:Transcriber;inspect?:typeof inspectAudio;prepare?:typeof prepareChunks;analyze?:typeof analyzeSpeech;backoff?:(attempt:number,signal:AbortSignal)=>Promise<void>;}
const ACTIVE=['queued','preparing','analyzing','uploading','transcribing','retrying'];
export class Engine {
 private queue:string[]=[];private running=false;private controller?:AbortController;private active?:string;private stopping=false;private flight?:Promise<void>;
 constructor(public store:Store,private options:EngineOptions){}
 get busy(){return this.running||this.queue.length>0;}
 async importAudio(path:string,filename:string){
  const size=(await stat(path)).size;if(size>8*1024**3)throw new AppError('This app accepts recordings up to 8 GB. Export a standard M4A from Voice Memos.');
  let audio:AudioInfo;try{audio=await(this.options.inspect??inspectAudio)(path);}catch(e){throw e instanceof AppError?e:new AppError('Could not inspect this audio. Check that FFmpeg is installed and choose a supported recording.');}
  const id=randomUUID();const dir=this.store.jobDir(id);await mkdir(dir,{recursive:true,mode:0o700});
  const extension=extname(filename).toLowerCase();const sourceFile=join(dir,'source'+(/^[.][a-z0-9]{1,6}$/.test(extension)?extension:'.audio'));
  await rename(path,sourceFile);
  const now=new Date().toISOString();
  const job:Job={id,filename:basename(filename).replace(/[\u0000-\u001f\u007f]/g,'').slice(0,255)||'Recording',createdAt:now,updatedAt:now,status:'ready',audio,settings:structuredClone(this.store.preferences.transcription),appSettings:structuredClone(this.store.preferences.app),chunks:[],text:'',partialText:'',sourceFile,audioAvailable:true,estimatedUsd:estimateCost(audio.duration)};
  this.store.save(job);return job;
 }
 async start(id:string,settings?:unknown,appSettings?:unknown){
  if(this.stopping)throw new AppError('The app is stopping. Open it again to resume.',409);
  const job=this.store.get(id);if(job.status==='complete')return job;if(ACTIVE.includes(job.status))return job;
  this.store.assertOwned(job);
  if(!job.audioAvailable)throw new AppError('The local audio copy is missing. Import the source recording again.');
  if(!await this.options.key())throw new AppError('Save your OpenAI API key in Settings first.');
  if(job.status==='ready'){job.settings=validateTranscription(settings??this.store.preferences.transcription);job.appSettings=validateApp(appSettings??this.store.preferences.app);}
  job.status='queued';job.error=undefined;this.store.save(job);this.queue.push(id);this.kick();return job;
 }
 private kick(){if(!this.running){this.running=true;this.flight=this.drain().catch(()=>{for(const j of this.store.list()){if(ACTIVE.includes(j.status)){j.status='failed';j.error='Local data could not be saved. Free disk space before resuming. Keep the app open to export completed text; an interrupted request may have been charged.';}}this.queue=[];}).finally(()=>{this.running=false;this.active=undefined;this.controller=undefined;});}}
 private async drain(){while(this.queue.length&&!this.stopping){const id=this.queue.shift()!;const job=this.store.get(id);if(job.status!=='queued')continue;this.active=id;this.controller=new AbortController();await this.process(job,this.controller.signal);}}
 private async process(job:Job,signal:AbortSignal){
  try{
   if(!job.chunks.length){job.status='preparing';this.store.save(job);job.chunks=await(this.options.prepare??prepareChunks)(job.sourceFile,join(this.store.jobDir(job.id),'audio'),job.audio,job.appSettings.chunkMinutes,signal);if(!job.chunks.length)throw new AppError('No audio sections could be prepared.');this.store.save(job);}
   if(!job.speech){
    signal.throwIfAborted();job.status='analyzing';this.store.save(job);
    try{const speech=await(this.options.analyze??analyzeSpeech)(job.sourceFile,job.audio,signal);signal.throwIfAborted();job.speech=speech;}
    catch(error){if(signal.aborted)throw error;job.speech={status:'unavailable',model:VAD_MODEL,version:VAD_VERSION,intervals:[],speechSeconds:0,analyzedSeconds:0,reason:'Local speech analysis could not be completed.'};}
    this.store.save(job);
   }
   for(const chunk of [...job.chunks].sort((a,b)=>a.index-b.index)){
    if(isChunkFinished(chunk))continue;
    signal.throwIfAborted();await this.processChunk(job,chunk,signal);
   }
   job.status='complete';job.error=undefined;job.partialText='';this.store.save(job);
   if(!job.appSettings.keepAudio&&!job.review?.needsReview)await this.cleanupAudio(job);
  }catch(error){
   if(signal.aborted){job.status=this.stopping?'paused':'cancelled';job.error='Stopped. Completed sections are saved. An in-flight request may still be charged.';}
   else if(error instanceof AppError){job.status='failed';job.error=error.message;}
   else{job.status='failed';job.error='The lecture could not be processed. Completed work is saved. Check free disk space, FFmpeg, and your network, then resume.';}
   this.store.save(job);
  }
 }
 private async processChunk(job:Job,chunk:Chunk,signal:AbortSignal){
  for(let retry=0;;retry++){
   signal.throwIfAborted();const key=await this.options.key();if(!key){this.pauseQueue('Save your API key, then resume.');throw new AppError('Save your API key in Settings, then resume.');}
   job.partialText='';job.status='uploading';chunk.status='pending';const attempt={startedAt:new Date().toISOString(),outcome:'pending' as const,estimatedUsd:estimateCost(chunk.end-chunk.start)};chunk.attempts.push(attempt);const index=chunk.attempts.length-1;this.store.save(job);this.store.record(job,chunk.id,index,attempt);
   let lastSave=0;let result:TranscribeResult;
   const persistProgress=()=>{try{this.store.save(job);}catch{throw new AppError('Local progress could not be saved. Free disk space before resuming; the request may have been charged.',500);}};
   try{
    result=await(this.options.transcriber??transcribe)({file:chunk.file,settings:job.settings,key,signal,onDelta:delta=>{job.partialText+=delta;if(Date.now()-lastSave>1000){persistProgress();lastSave=Date.now();}},onPhase:phase=>{job.status=phase;persistProgress();}});
   }catch(error){
    const info=error instanceof AppError?{message:error.message,retryable:false,uncertain:true,stopQueue:true}:classifyError(error);
    const status=error&&typeof error==='object'?(error as {status?:number}).status:undefined;
    chunk.status=signal.aborted||(info.uncertain&&(!status||status===408))?'interrupted':'failed';
    chunk.attempts[index]={...attempt,outcome:signal.aborted||info.uncertain?'uncertain':'failed',endedAt:new Date().toISOString()};this.store.save(job);this.store.record(job,chunk.id,index,chunk.attempts[index]);
    if(signal.aborted)throw error;
    if(info.stopQueue)this.pauseQueue(info.message);
    if(!info.retryable||retry>=job.appSettings.retries)throw new AppError(info.message);
    job.status='retrying';job.error=`${info.message} Automatic retry ${retry+1} of ${job.appSettings.retries}.`;this.store.save(job);
    await(this.options.backoff??((n,s)=>delay(Math.min(30_000,1500*2**n)+Math.floor(Math.random()*400),undefined,{signal:s})))(retry,signal);job.error=undefined;continue;
   }
   // Persistence failures never trigger another paid API request automatically.
   try{this.store.saveResponse(job,chunk.id,result);}catch{chunk.status='interrupted';chunk.attempts[index]={...attempt,outcome:'uncertain',endedAt:new Date().toISOString()};this.pauseQueue('Free disk space before resuming.');throw new AppError('The returned section could not be saved. Free disk space before resuming; this successful API request may have been charged.',500);}
   applyResponse(chunk,result);chunk.attempts[index]={...attempt,outcome:'success',endedAt:new Date().toISOString()};job.partialText='';this.store.save(job);this.store.record(job,chunk.id,index,chunk.attempts[index]);return;
  }
 }
 private pauseQueue(reason:string){for(const id of this.queue){const j=this.store.get(id);j.status='paused';j.error=reason;this.store.save(j);}this.queue=[];}
 cancel(id:string){const job=this.store.get(id);if(job.status==='complete')return job;this.queue=this.queue.filter(x=>x!==id);if(this.active===id&&this.controller){this.controller.abort();}else{job.status='cancelled';job.error='Stopped. Completed sections are saved.';this.store.save(job);}return job;}
 async remove(id:string){const job=this.store.get(id);if(ACTIVE.includes(job.status)||this.active===id&&this.running)throw new AppError('Stop this lecture before deleting it.',409);this.store.remove(id);}
 async cleanupAudio(job:Job){refreshReview(job);if(job.status!=='complete'||!job.chunks.length||!job.chunks.every(isChunkFinished)||job.appSettings.keepAudio||job.review?.needsReview)return;try{this.store.assertOwned(job);await rm(join(this.store.jobDir(job.id),'audio'),{recursive:true,force:true});await rm(job.sourceFile,{force:true});job.audioAvailable=false;this.store.save(job);}catch{job.error='Transcription is complete. Temporary audio could not be cleaned up; you can delete this lecture from history after exporting.';this.store.save(job);}}
 async stop(){this.stopping=true;this.pauseQueue('The app stopped. Resume when you reopen it.');this.controller?.abort();await this.flight;}
 async idle(){await this.flight;}
}
