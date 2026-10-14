import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {mkdirSync,chmodSync,rmSync,readdirSync,existsSync,lstatSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {Store} from './store.js';
import {Engine} from './engine.js';
import {MacOSKeyStore} from './keychain.js';
import {createApp} from './http.js';
import {checkFfmpeg} from './audio.js';
import {PRICING} from '../shared/config.js';
import {AppError} from './validation.js';
process.umask(0o077);
const appRoot=fileURLToPath(new URL(import.meta.url.endsWith('.ts')?'../':'../../',import.meta.url));
// A non-secret override is useful for isolated local development and automated checks.
const dataDir=process.env.LECTURE_DATA_DIR?resolve(process.env.LECTURE_DATA_DIR):join(homedir(),process.platform==='darwin'?'Library/Application Support/Lecture Transcriber':'.local/share/lecture-transcriber');
const port=43187;
async function main(){
 if(existsSync(dataDir)&&lstatSync(dataDir).isSymbolicLink())throw new AppError('The local data folder must not be a symbolic link.',500);
 mkdirSync(dataDir,{recursive:true,mode:0o700});chmodSync(dataDir,0o700);
 // Bind before opening manifests: simultaneous launchers must not mutate the same local store.
 const {createServer}=await import('node:http');const server=createServer();
 await new Promise<void>((resolveReady,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolveReady);});
 try{
  const store=new Store(dataDir);const keyStore=new MacOSKeyStore(join(appRoot,'bin','keychain-helper'));
  const engine=new Engine(store,{key:()=>keyStore.get()});
  for(const job of store.list())if(job.status==='complete'&&job.audioAvailable&&!job.appSettings.keepAudio)await engine.cleanupAudio(job);
  const uploadDir=join(dataDir,'uploads');
  for(const file of readdirSync(uploadDir))rmSync(join(uploadDir,file),{recursive:true,force:true});
  let stopping=false;
  const shutdown=async()=>{if(stopping)return;stopping=true;await engine.stop();server.close(()=>process.exit(0));server.closeAllConnections();};
  const ffmpegAvailable=await checkFfmpeg();
  const app=createApp({port,dataDir,uploadDir,clientDir:join(appRoot,'dist','client'),keyStore,
   bootstrap:()=>({preferences:store.preferences,jobs:store.list(),pricing:PRICING,ffmpegAvailable,usage:store.usage()}),
   listJobs:()=>store.list(),getJob:id=>store.jobs.get(id),importAudio:(path,filename)=>engine.importAudio(path,filename),
   startJob:(id,settings,appSettings)=>engine.start(id,settings,appSettings),cancelJob:id=>engine.cancel(id),deleteJob:id=>engine.remove(id),
   savePreferences:prefs=>store.savePreferences(prefs),beforeKeyChange:()=>{if(engine.busy)throw new AppError('Stop queued and active lectures before changing your API key.',409);},shutdown});
  server.on('request',app);
  process.on('SIGINT',()=>void shutdown());process.on('SIGTERM',()=>void shutdown());
  console.log(`Lecture Transcriber is running at http://127.0.0.1:${port}`);
 }catch{server.close();console.error('Lecture Transcriber could not start. Check that its local data folder is accessible and saved manifests are valid. Your files have not been deleted.');process.exitCode=1;}
}
main().catch(error=>{if(error?.code==='EADDRINUSE'){console.error('Port 43187 is already in use. Open the existing app, or close the program using that port.');}else{console.error('Lecture Transcriber could not start. Check local folder permissions and installed prerequisites.');}process.exitCode=1;});
