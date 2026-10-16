import { useCallback, useEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from 'react';
import type { AppSettings, Bootstrap, Chunk, Job, JobStatus, Preferences, TranscriptionSettings } from '../shared/types';
import { DEFAULTS, MODEL } from '../shared/config';
import { chunkAnnotation, countWords, formatTimestamp, isChunkFinished, REVIEW_EXPLANATION } from '../shared/review';

type IconName = 'wave'|'plus'|'upload'|'file'|'settings'|'chevron'|'arrow'|'search'|'copy'|'download'|'close'|'check'|'shield'|'key'|'sun'|'moon'|'monitor'|'stop'|'trash'|'refresh'|'external'|'headphones'|'warning'|'play'|'pause';
function Icon({ name, size = 20, ...props }: { name: IconName; size?: number; className?: string }) {
  const paths: Record<IconName, ReactNode> = {
    wave: <path d="M4 10v4m4-8v12m4-15v18m4-15v12m4-8v4" />,
    warning: <><path d="m12 3 10 18H2Z"/><path d="M12 9v5m0 3h.01"/></>,
    play: <path d="m8 4 12 8-12 8Z"/>,
    pause: <><path d="M8 4v16M16 4v16"/></>,
    plus: <path d="M12 5v14M5 12h14" />,
    upload: <><path d="M12 16V3m-5 5 5-5 5 5M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" /></>,
    file: <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Zm0 0v6h6M8 13h8m-8 4h6" /></>,
    settings: <><path d="M4 7h8m4 0h4M4 17h3m4 0h9" /><circle cx="14" cy="7" r="2"/><circle cx="9" cy="17" r="2"/></>,
    chevron: <path d="m9 5 7 7-7 7" />,
    arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
    search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
    copy: <><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></>,
    download: <path d="M12 3v13m-5-5 5 5 5-5M4 17v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    check: <path d="m5 12 4 4L19 6" />,
    shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z"/><path d="m8 12 3 3 5-6"/></>,
    key: <><circle cx="8" cy="8" r="5"/><path d="m12 12 9 9m-3-3 3-3m-6 0 3-3" /></>,
    sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/></>,
    moon: <path d="M21 13a9 9 0 0 1-10-10A9 9 0 1 0 21 13Z" />,
    monitor: <><rect x="3" y="3" width="18" height="13" rx="2"/><path d="M8 21h8m-4-5v5"/></>,
    stop: <rect x="6" y="6" width="12" height="12" rx="2"/>,
    trash: <><path d="M3 6h18m-13 0V3h8v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/></>,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 6a8 8 0 0 1 13 2M5 16a8 8 0 0 0 13 2"/></>,
    external: <><path d="M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/></>,
    headphones: <><path d="M4 14v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="12" width="5" height="9" rx="2"/><rect x="16" y="12" width="5" height="9" rx="2"/></>,
  };
  return <svg {...props} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

const ACTIVE = new Set<JobStatus>(['queued','preparing','analyzing','uploading','transcribing','retrying']);
const STARTABLE = new Set<JobStatus>(['ready','paused','failed','cancelled']);
const STATUS: Record<JobStatus,string> = { ready:'Ready to transcribe',queued:'In queue',preparing:'Preparing audio',analyzing:'Analyzing speech locally',uploading:'Sending audio / waiting for transcript',transcribing:'Transcribing',retrying:'Waiting to retry',paused:'Paused · ready to resume',failed:'Needs attention',cancelled:'Cancelled · work saved',complete:'Complete' };
const LANGUAGES = [{code:'ro',label:'Romanian'}, {code:'en',label:'English'}, {code:'fr',label:'French'}, {code:'de',label:'German'}, {code:'es',label:'Spanish'}, {code:'it',label:'Italian'}];
const ACCEPT = '.m4a,.mp3,.mp4,.wav,.flac,.ogg,.opus,.aac,.aif,.aiff,.webm,.mov,.wma,audio/*';
const money = (amount: number) => amount < 0.01 && amount > 0 ? '< $0.01' : `$${amount.toFixed(2)}`;
const duration = (seconds: number) => seconds < 60 ? `${Math.round(seconds)} sec` : seconds < 3600 ? `${Math.floor(seconds/60)} min ${Math.round(seconds%60)} sec` : `${Math.floor(seconds/3600)} hr ${Math.round(seconds%3600/60)} min`;
const size = (bytes: number) => bytes < 1_000_000 ? `${Math.round(bytes/1000)} KB` : `${(bytes/1_000_000).toFixed(1)} MB`;
const cloneDefaults = () => structuredClone(DEFAULTS);
const normalizeSettings = (settings: TranscriptionSettings): TranscriptionSettings => ({ ...settings, keywords: settings.keywords.map(term => term.trim()).filter(Boolean) });

const needsReview = (job: Job) => !!job.review?.needsReview || job.chunks.some(chunk=>chunk.status==='no_text'||chunk.review?.kind==='short_text');
const rangeLabel = (chunk: Pick<Chunk,'start'|'end'>) => `${formatTimestamp(chunk.start)}–${formatTimestamp(chunk.end)}`;
function reviewEvidence(chunk: Chunk): string {
  const seconds=(chunk.end-chunk.start).toFixed(1).replace(/\.0$/,'');
  const review=chunk.review;
  const words=review?.wordCount??countWords(chunk.text??'');
  const basis=review?.basis==='speech'
    ? `${(review.speechSeconds??0).toFixed(1).replace(/\.0$/,'')} s of locally detected speech`
    : 'duration-only check; speech analysis unavailable';
  const rate=review?.wordsPerMinute===undefined?'':` · ${review.wordsPerMinute.toFixed(1)} words/min`;
  return `${words} words · ${seconds} s section · ${basis}${rate}`;
}
type TranscriptSegment={text:string;chunk?:Chunk;draft?:boolean};
/** Replace only app-generated annotations, preserving every character of the saved text. */
function transcriptSegments(job: Job | undefined): TranscriptSegment[] {
  if(!job)return [];
  const segments:TranscriptSegment[]=[];
  let cursor=0,sectionOffset=0,draftInserted=false;
  const unfinished=[...job.chunks].sort((a,b)=>a.index-b.index).find(chunk=>!isChunkFinished(chunk));
  for(const chunk of [...job.chunks].sort((a,b)=>a.index-b.index)) {
    const annotation=chunkAnnotation(job,chunk);
    const section=[annotation,chunk.status==='complete'?chunk.text:undefined].filter(value=>value!==undefined).join('\n');
    const position=sectionOffset;
    sectionOffset+=section.length+2;
    // Match only the structural start of this section. Identical text spoken in
    // an earlier section remains ordinary transcript text, never an app marker.
    if(!annotation||job.text.slice(position,position+annotation.length)!==annotation)continue;
    if(position>cursor)segments.push({text:job.text.slice(cursor,position)});
    segments.push({text:annotation,chunk});
    if(job.partialText&&unfinished?.id===chunk.id){segments.push({text:job.partialText,chunk,draft:true});draftInserted=true;}
    cursor=position+annotation.length;
  }
  if(cursor<job.text.length)segments.push({text:job.text.slice(cursor)});
  if(job.partialText&&!draftInserted)segments.push({text:job.partialText,chunk:unfinished,draft:true});
  return segments;
}

type PlaybackRange={jobId:string;chunkId:string;start:number;end:number;request:number};
type ReviewPlayerHandle={playRange:(range:PlaybackRange)=>void};
function ReviewPlayer({job,range,onClear,playerRef}:{job:Job;range?:PlaybackRange;onClear:()=>void;playerRef:Ref<ReviewPlayerHandle>}) {
  const audioRef=useRef<HTMLAudioElement>(null);
  const pending=useRef(false);
  const rangeRef=useRef(range);rangeRef.current=range;
  const [playing,setPlaying]=useState(false);
  const [clock,setClock]=useState(0);
  const [error,setError]=useState('');
  const playSelected=useCallback(async()=>{
    const audio=audioRef.current,current=rangeRef.current;
    if(!audio||!current)return;
    try {
      pending.current=audio.readyState<1;
      if(!pending.current)audio.currentTime=current.start;
      // Call play directly from the user's click, including before metadata loads.
      // This preserves Safari's media activation permission.
      await audio.play();
      if(rangeRef.current?.request!==current.request)audio.pause();
    } catch {setError('Playback could not start. Press Play interval to try again, or open your original recording at the times shown.');}
  },[]);
  useImperativeHandle(playerRef,()=>({playRange:next=>{
    rangeRef.current=next;setError('');audioRef.current?.pause();
    void playSelected();
  }}),[playSelected]);
  useEffect(()=>{
    const audio=audioRef.current;audio?.pause();setPlaying(false);setError('');pending.current=false;
  },[job.id,job.audioAvailable]);
  const stopAtEnd=useCallback(()=>{
    const audio=audioRef.current,current=rangeRef.current;
    if(audio&&current&&audio.currentTime>=current.end&&!audio.paused){audio.pause();audio.currentTime=current.end;setPlaying(false);}
  },[]);
  useEffect(()=>{
    const audio=audioRef.current;
    if(!audio||!range||!playing)return;
    let frame=0;
    const tick=()=>{stopAtEnd();frame=requestAnimationFrame(tick);};
    frame=requestAnimationFrame(tick);
    // The timer supplements timeupdate/animation frames when the tab is in the background.
    const timer=window.setTimeout(()=>{if(audio.currentTime>=range.end-.04){audio.pause();audio.currentTime=range.end;setPlaying(false);}},Math.max(0,(range.end-audio.currentTime)/audio.playbackRate*1000));
    return()=>{cancelAnimationFrame(frame);clearTimeout(timer);};
  },[range,playing,clock,stopAtEnd]);
  return <>
    {job.audioAvailable?<audio ref={audioRef} key={job.id} controls preload="metadata" src={`/api/jobs/${job.id}/audio`} aria-label={`Preview ${job.filename}`}
      onLoadedMetadata={()=>{if(pending.current&&audioRef.current&&rangeRef.current){pending.current=false;audioRef.current.currentTime=rangeRef.current.start;setClock(value=>value+1);}}}
      onPlay={()=>{setPlaying(true);setClock(value=>value+1);}}
      onPause={()=>setPlaying(false)} onEnded={()=>setPlaying(false)}
      onTimeUpdate={stopAtEnd} onSeeked={()=>{setClock(value=>value+1);stopAtEnd();}} onRateChange={()=>setClock(value=>value+1)}
      onError={()=>{pending.current=false;setError('The working audio could not be opened. Open your original recording at the displayed interval; your original file is untouched.');}}/>
      :<p className="audio-unavailable">Working audio is unavailable. Your original recording is untouched. To review an interval, open the original file and use the times shown below.</p>}
    {range&&<div className="review-player-range" aria-label="Selected review interval">
      <div><strong role="status">{playing?'Playing review interval':'Review interval'}</strong><span>{rangeLabel(range)}</span><small>{job.filename}</small></div>
      {job.audioAvailable&&<button className="button secondary small" onClick={()=>{if(playing)audioRef.current?.pause();else void playSelected();}}><Icon name={playing?'pause':'play'} size={14}/>{playing?'Pause':'Play interval'}</button>}
      <button className="text-button" onClick={()=>{audioRef.current?.pause();pending.current=false;onClear();}}>Clear interval</button>
      <p>Playback uses the full section boundaries and pauses at the end. The position of any missing words within the section is unknown.</p>
    </div>}
    {error&&<p className="review-audio-error" role="status">{error}</p>}
  </>;
}

function Dialog({ title, onClose, children, className='' }: {title:string;onClose:()=>void;children:ReactNode;className?:string}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const focusable = () => [...(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select,textarea,a[href],[tabindex="0"]') ?? [])];
    focusable()[0]?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab') {
        const items = focusable(), first=items[0], last=items[items.length-1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown',keydown);
    return () => { document.removeEventListener('keydown',keydown); previous?.focus(); };
  },[onClose]);
  return <div className="dialog-backdrop" onMouseDown={event => {if(event.target===event.currentTarget)onClose();}}><div ref={ref} className={`dialog ${className}`} role="dialog" aria-modal="true" aria-label={title}><header className="dialog-header"><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label="Close dialog"><Icon name="close"/></button></header>{children}</div></div>;
}

export default function App() {
  const [boot,setBoot] = useState<Bootstrap>();
  const [jobs,setJobs] = useState<Job[]>([]);
  const [preferences,setPreferences] = useState<Preferences>(cloneDefaults);
  const [selectedId,setSelectedId] = useState<string>();
  const [checked,setChecked] = useState<Set<string>>(new Set());
  const [notice,setNotice] = useState<{type:'error'|'success';text:string}>();
  const [connectionError,setConnectionError] = useState('');
  const [loading,setLoading] = useState(true);
  const [importing,setImporting] = useState('');
  const [dragging,setDragging] = useState(false);
  const [setupOpen,setSetupOpen] = useState(false);
  const [appOpen,setAppOpen] = useState(false);
  const [keyOpen,setKeyOpen] = useState(false);
  const [keyInput,setKeyInput] = useState('');
  const [keyError,setKeyError] = useState('');
  const [keyBusy,setKeyBusy] = useState(false);
  const [busy,setBusy] = useState(false);
  const [saved,setSaved] = useState(false);
  const [presetName,setPresetName] = useState('');
  const [search,setSearch] = useState('');
  const [searchIndex,setSearchIndex] = useState(0);
  const [copied,setCopied] = useState(false);
  const [deleteId,setDeleteId] = useState<string>();
  const [stopOpen,setStopOpen] = useState(false);
  const [stopped,setStopped] = useState(false);
  const [playbackRange,setPlaybackRange] = useState<PlaybackRange>();
  const reviewPlayerRef=useRef<ReviewPlayerHandle>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const bootRef = useRef(boot);
  bootRef.current = boot;

  const request = useCallback(async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
    const headers = new Headers(init.headers);
    if (init.method && !['GET','HEAD'].includes(init.method)) headers.set('X-CSRF-Token',bootRef.current?.csrfToken ?? '');
    if (typeof init.body === 'string') headers.set('Content-Type','application/json');
    let response: Response;
    try { response = await fetch(path,{...init,headers,credentials:'same-origin'}); }
    catch { throw new Error('Cannot reach the local app. Reopen Lecture Transcriber using its launcher, then refresh this page.'); }
    if (!response.ok) {
      const data = await response.json().catch(() => null) as {error?: string|{message?:string};message?:string}|null;
      const message = typeof data?.error==='string' ? data.error : data?.error?.message ?? data?.message;
      throw new Error(message || `The request could not be completed (${response.status}). Please try again.`);
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  },[]);
  const refresh = useCallback(async () => {
    const data = await request<Bootstrap>('/api/bootstrap');
    setBoot(data);setJobs(data.jobs);setConnectionError('');
    return data;
  },[request]);

  useEffect(() => {
    let ignore=false;
    request<Bootstrap>('/api/bootstrap').then(data => {
      if(ignore)return;
      setBoot(data);setJobs(data.jobs);setPreferences(data.preferences);setSelectedId(data.jobs[0]?.id);
      setKeyOpen(!data.keyConfigured);setLoading(false);
    }).catch(error=>{if(!ignore){setConnectionError(error.message);setLoading(false);}});
    return ()=>{ignore=true;};
  },[request]);
  useEffect(() => {
    document.documentElement.dataset.theme=preferences.app.theme;
  },[preferences.app.theme]);
  const active = jobs.some(job=>ACTIVE.has(job.status));
  useEffect(() => {
    if(!boot || stopped)return;
    let disposed=false, pending=false;
    const timer=window.setInterval(async()=>{
      if(pending)return;pending=true;
      try {
        const result=await request<Job[]>('/api/jobs');
        if(disposed)return;
        setJobs(result);setConnectionError('');
        if(active && !result.some(job=>ACTIVE.has(job.status))) await refresh();
      } catch(error) {if(!disposed)setConnectionError((error as Error).message);}
      finally {pending=false;}
    },active?1000:5000);
    return ()=>{disposed=true;window.clearInterval(timer);};
  },[active,!!boot,stopped,request,refresh]);
  useEffect(()=>{if(notice?.type==='success'){const timer=setTimeout(()=>setNotice(undefined),5000);return()=>clearTimeout(timer);}},[notice]);
  useEffect(()=>{setSearch('');setSearchIndex(0);setPlaybackRange(undefined);},[selectedId]);
  const selected = jobs.find(job=>job.id===selectedId);
  const text = selected?.text ?? '';
  const segments = transcriptSegments(selected);
  const flagged = selected ? needsReview(selected) : false;
  const reviewChunks = selected?.chunks.filter(chunk=>chunk.status==='no_text'||chunk.review?.kind==='short_text').sort((a,b)=>a.index-b.index) ?? [];
  const orderedChunks = [...(selected?.chunks??[])].sort((a,b)=>a.index-b.index);
  const finished = orderedChunks.filter(isChunkFinished).length;
  const selectedJobs = jobs.filter(job=>checked.has(job.id) && STARTABLE.has(job.status));
  const readyJobs = jobs.filter(job=>job.status==='ready');
  const batch = selectedJobs.length ? selectedJobs : readyJobs;
  const estimate = batch.reduce((sum,job)=>sum+job.estimatedUsd,0);
  const completed = selected?.chunks.filter(chunk=>chunk.status==='complete').length ?? 0;
  const noTextCount = selected?.chunks.filter(chunk=>chunk.status==='no_text').length ?? 0;
  const query = search.trim();
  const splitSearch = (value:string) => query ? value.split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')})`,'gi')) : [value];
  const matches = query ? segments.reduce((sum,segment)=>sum+Math.floor(splitSearch(segment.text).length/2),0) : 0;
  let matchIndex=0;
  const highlighted = (value:string) => splitSearch(value).map((part,index)=>{
    if(!query||index%2===0)return part;
    const current=matchIndex++;
    return <mark key={index} data-match={current} className={current===searchIndex?'current-match':''}>{part}</mark>;
  });
  function playReviewInterval(chunk:Chunk) {
    if(!selected||!Number.isFinite(chunk.start)||!Number.isFinite(chunk.end)||chunk.end<=chunk.start)return;
    const range={jobId:selected.id,chunkId:chunk.id,start:chunk.start,end:chunk.end,request:performance.now()};
    setPlaybackRange(range);reviewPlayerRef.current?.playRange(range);
  }
  useEffect(()=>{setSearchIndex(0);},[query]);
  useEffect(()=>{transcriptRef.current?.querySelector<HTMLElement>(`[data-match="${searchIndex}"]`)?.scrollIntoView({block:'nearest',behavior:'smooth'});},[searchIndex,query]);

  function errorNotice(error: unknown) {setNotice({type:'error',text:error instanceof Error?error.message:'Something went wrong. Please try again.'});}
  function changeTranscription(update: Partial<TranscriptionSettings>) {setSaved(false);setPreferences(current=>({...current,transcription:{...current.transcription,...update}}));}
  function changeApp(update: Partial<AppSettings>) {setSaved(false);setPreferences(current=>({...current,app:{...current.app,...update}}));}
  async function savePreferences(next=preferences) {
    next={...next,transcription:normalizeSettings(next.transcription),presets:next.presets.map(preset=>({...preset,settings:normalizeSettings(preset.settings)}))};
    setNotice(undefined);
    try {
      if(!Number.isFinite(next.app.chunkMinutes)||next.app.chunkMinutes<1||next.app.chunkMinutes>10)throw new Error('Choose a section duration from 1 to 10 minutes.');
      if(!Number.isInteger(next.app.retries)||next.app.retries<0||next.app.retries>5)throw new Error('Retry limit must be from 0 to 5.');
      await request('/api/preferences',{method:'PUT',body:JSON.stringify(next)});
      setPreferences(next);setSaved(true);
      if(boot)setBoot({...boot,preferences:next});
    }catch(error){errorNotice(error);}
  }
  async function importFiles(files: FileList|File[]) {
    if(importing || !files.length)return;
    setDragging(false);setNotice(undefined);
    const list=Array.from(files);
    for(let index=0;index<list.length;index++) {
      const file=list[index];setImporting(`Inspecting ${index+1} of ${list.length}: ${file.name}`);
      try {
        const form=new FormData();form.append('file',file);
        const job=await request<Job>('/api/jobs',{method:'POST',body:form});
        setJobs(current=>[job,...current.filter(existing=>existing.id!==job.id)]);
        setSelectedId(job.id);setChecked(current=>new Set([...current,job.id]));
      }catch(error){errorNotice(new Error(`${file.name}: ${(error as Error).message}`));}
    }
    setImporting('');if(fileRef.current)fileRef.current.value='';
  }
  async function startJobs(targets: Job[]) {
    if(!boot?.keyConfigured){setKeyOpen(true);return;}
    setBusy(true);setNotice(undefined);
    try {
      for(const job of targets) {
        const updated=await request<Job>(`/api/jobs/${job.id}/start`,{method:'POST',body:JSON.stringify({settings:normalizeSettings(preferences.transcription),appSettings:preferences.app})});
        setJobs(current=>current.map(item=>item.id===updated.id?updated:item));
      }
      if(targets.length)setSelectedId(targets[0].id);
      setChecked(new Set());await refresh();
    }catch(error){errorNotice(error);await refresh().catch(()=>{});}
    finally{setBusy(false);}
  }
  async function cancelJob(job: Job) {
    setBusy(true);
    try {await request(`/api/jobs/${job.id}/cancel`,{method:'POST'});await refresh();}
    catch(error){errorNotice(error);}finally{setBusy(false);}
  }
  async function removeJob() {
    if(!deleteId)return;setBusy(true);
    try {
      await request(`/api/jobs/${deleteId}`,{method:'DELETE'});
      const remaining=jobs.filter(job=>job.id!==deleteId);setJobs(remaining);
      if(selectedId===deleteId)setSelectedId(remaining[0]?.id);
      setChecked(current=>new Set([...current].filter(id=>id!==deleteId)));setDeleteId(undefined);
    }catch(error){errorNotice(error);}finally{setBusy(false);}
  }
  const closeKey=useCallback(()=>{setKeyOpen(false);setKeyInput('');setKeyError('');},[]);
  const closeApp=useCallback(()=>setAppOpen(false),[]);
  const closeDelete=useCallback(()=>setDeleteId(undefined),[]);
  const closeStop=useCallback(()=>setStopOpen(false),[]);
  async function saveKey() {
    const key=keyInput.trim();if(!key)return;
    setKeyInput('');setKeyBusy(true);setKeyError('');
    try {await request('/api/key',{method:'POST',body:JSON.stringify({key})});await refresh();closeKey();setNotice({type:'success',text:'API key saved securely in macOS Keychain.'});}
    catch(error){setKeyError((error as Error).message);}finally{setKeyBusy(false);}
  }
  async function removeKey() {
    setKeyBusy(true);
    try {await request('/api/key',{method:'DELETE'});await refresh();setNotice({type:'success',text:'API key removed from macOS Keychain.'});}
    catch(error){errorNotice(error);}finally{setKeyBusy(false);}
  }
  async function copyText() {
    try {await navigator.clipboard.writeText(text);setCopied(true);setTimeout(()=>setCopied(false),1800);}
    catch{setNotice({type:'error',text:'Clipboard access was blocked. Select the transcript text and press Command-C to copy it.'});}
  }
  async function stopApp() {
    setBusy(true);
    try {await request('/api/shutdown',{method:'POST'});setStopped(true);setStopOpen(false);}
    catch(error){errorNotice(error);}finally{setBusy(false);}
  }
  function addPreset() {
    const name=presetName.trim();if(!name)return;
    const next={...preferences,presets:[...preferences.presets.filter(preset=>preset.name!==name),{name,settings:structuredClone(preferences.transcription)}]};
    setPresetName('');void savePreferences(next);
  }

  if(stopped)return <main className="splash"><div className="brand-icon"><Icon name="wave" size={32}/></div><h1>All saved. See you next lecture.</h1><p>Lecture Transcriber has stopped. You can close this tab.</p><p className="muted">Double-click the launcher when you’re ready to return.</p></main>;
  if(loading || !boot)return <main className="splash"><div className="brand-icon"><Icon name="wave" size={32}/></div><h1>Lecture Transcriber</h1><p>{loading?'Opening your local workspace…':connectionError}</p>{!loading&&<button className="button primary" onClick={()=>window.location.reload()}>Try again</button>}</main>;

  return <div className="app-shell" onDragOver={event=>{if(event.dataTransfer.types.includes('Files')){event.preventDefault();setDragging(true);}}} onDragLeave={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node))setDragging(false);}} onDrop={event=>{event.preventDefault();void importFiles(event.dataTransfer.files);}}>
    <input ref={fileRef} type="file" multiple accept={ACCEPT} className="sr-only" aria-label="Choose lecture recordings" onChange={event=>{if(event.target.files)void importFiles(event.target.files);}}/>
    <aside className="sidebar">
      <a className="brand" href="#" onClick={event=>{event.preventDefault();setSelectedId(undefined);}} aria-label="Lecture Transcriber home"><span className="brand-icon"><Icon name="wave" size={24}/></span><span>Lecture<span className="brand-subtitle">TRANSCRIBER</span></span></a>
      <button className="button primary new-lecture" disabled={!!importing || !boot.ffmpegAvailable} onClick={()=>fileRef.current?.click()}><Icon name="plus" size={18}/> Add recording</button>
      <div className="library-heading"><h2>Your lectures</h2><span>{jobs.length}</span></div>
      <nav className="lecture-list" aria-label="Saved lectures">
        {jobs.length===0 ? <div className="library-empty"><Icon name="file" size={24}/><p>A place for every lecture.</p><span>Your recordings will appear here.</span></div> : jobs.map(job=><div key={job.id} className={`lecture-item ${selectedId===job.id?'selected':''} ${needsReview(job)?'lecture-needs-review':''}`}>
          {STARTABLE.has(job.status) && <input type="checkbox" checked={checked.has(job.id)} aria-label={`Select ${job.filename} for transcription`} onChange={event=>setChecked(current=>{const next=new Set(current);event.target.checked?next.add(job.id):next.delete(job.id);return next;})}/>}
          <button className="lecture-select" onClick={()=>setSelectedId(job.id)}><span className="lecture-name">{job.filename}</span><span className={`lecture-meta ${needsReview(job)?'review-meta':''}`}>{needsReview(job)?<Icon name="warning" size={12}/>:<span className={`status-dot ${job.status}`}/>} {needsReview(job)?(job.status==='complete'?'Finished · review needed':`${STATUS[job.status]} · review needed`):job.status==='complete'?duration(job.audio.duration):STATUS[job.status]}</span></button>
        </div>)}
      </nav>
      {batch.length>0 && <div className="queue-action"><div><span>{selectedJobs.length?'Selected':'Ready'} · {batch.length} {batch.length===1?'lecture':'lectures'}</span><strong>~ {money(estimate)}</strong></div><button className="button primary" disabled={busy||!boot.ffmpegAvailable} onClick={()=>void startJobs(batch)}><Icon name="wave" size={17}/>{selectedJobs.length?'Transcribe selected':'Transcribe all ready'}</button><p>Processed one at a time.</p></div>}
      <div className="sidebar-bottom"><div className="local-note"><Icon name="shield" size={16}/><span>Saved on this Mac</span><span className="local-dot"/></div><button className="sidebar-settings" onClick={()=>{setSaved(false);setAppOpen(true);}}><Icon name="settings" size={18}/><span>App settings</span><Icon name="chevron" size={14}/></button><div className="sidebar-footnote">Your words, kept as spoken.</div></div>
    </aside>
    <main className="main-content">
      <header className="topbar"><span className="breadcrumb"><Icon name="headphones" size={16}/> Your workspace <span>/</span> <strong>{selected?'Lecture':'Overview'}</strong></span><button className={`key-status ${boot.keyConfigured?'connected':''}`} onClick={()=>setKeyOpen(true)}><span className="status-dot"/>{boot.keyConfigured?'API key connected':'Connect API key'}<Icon name="chevron" size={12}/></button></header>
      <div className="page-body">
        {(notice || connectionError) && <div className={`notice ${connectionError||notice?.type==='error'?'error':'success'}`} role={connectionError||notice?.type==='error'?'alert':'status'}><span>{connectionError||notice?.text}</span><button className="icon-button" aria-label="Dismiss message" onClick={()=>{setNotice(undefined);setConnectionError('');}}><Icon name="close" size={16}/></button></div>}
        {!boot.ffmpegAvailable && <div className="notice error" role="alert"><span><strong>Audio tools need to be installed.</strong> FFmpeg and ffprobe were not found. Follow the first-time setup instructions, then restart the app.</span></div>}
        <div className="page-heading"><div><span className="eyebrow">A LITTLE MORE CLARITY</span><h1>{selected?selected.filename.replace(/\.[^.]+$/,''):'Focus on the lecture. We’ll keep the words.'}</h1><p>{selected?'Original spoken words. Ready to read, search, and keep.':'Turn your recordings into readable text, in the language they were spoken.'}</p></div>{selected&&<button className="icon-button delete-button" title="Delete from app history" aria-label={`Delete ${selected.filename} from app history`} onClick={()=>setDeleteId(selected.id)} disabled={ACTIVE.has(selected.status)}><Icon name="trash" size={19}/></button>}</div>
        {!selected ? <section className={`upload-card ${importing?'is-importing':''}`} aria-label="Add an audio recording"><div className="upload-visual"><Icon name="upload" size={28}/><span className="upload-orbit"/></div><div className="upload-content"><h2>{importing?'Getting your recording ready…':'Start with a recording'}</h2><p>{importing||'Drop your audio here, or choose a file from your Mac.'}</p><span>Voice Memos M4A · MP3 · WAV · FLAC and more</span></div><button className="button primary" onClick={()=>fileRef.current?.click()} disabled={!!importing||!boot.ffmpegAvailable}>{importing?<span className="spinner"/>:<Icon name="plus" size={18}/>}Choose audio</button><div className="upload-footer"><Icon name="shield" size={14}/>Files stay local until you choose Transcribe.</div></section> : <section className="audio-card" aria-label="Recording details"><div className="audio-file-icon"><Icon name="wave" size={25}/></div><div className="audio-details"><strong title={selected.filename}>{selected.filename}</strong><div><span>{duration(selected.audio.duration)}</span><span>{size(selected.audio.size)}</span><span>{selected.audio.codec.toUpperCase()} · {selected.audio.channels===1?'Mono':`${selected.audio.channels} channels`}</span></div></div><div className="audio-cost"><span>Estimated cost</span><strong>~ {money(selected.estimatedUsd)}</strong></div><ReviewPlayer playerRef={reviewPlayerRef} job={selected} range={playbackRange?.jobId===selected.id?playbackRange:undefined} onClear={()=>setPlaybackRange(undefined)}/></section>}

        <section className={`setup-panel ${setupOpen?'expanded':''}`}>
          <button className="setup-summary" onClick={()=>setSetupOpen(!setupOpen)} aria-expanded={setupOpen} aria-controls="transcription-settings"><span className="setup-heading"><Icon name="settings" size={18}/><strong>Transcription settings</strong></span><span className="setup-preview">{preferences.transcription.languages.length?preferences.transcription.languages.map(code=>LANGUAGES.find(lang=>lang.code===code)?.label??code.toUpperCase()).join(', '):'Auto-detect language'}<span>·</span>{preferences.transcription.stream?'Live text on':'Live text off'}</span><code>{MODEL}</code><Icon name="chevron" size={14} className="setup-chevron"/></button>
          {setupOpen&&<div id="transcription-settings" className="setup-fields"><div className="settings-intro"><p>These settings apply to new transcriptions. Resuming a lecture uses its saved settings.</p><button className="text-button" onClick={()=>{setPreferences(current=>({...current,transcription:structuredClone(DEFAULTS.transcription)}));setSaved(false);}}>Reset to defaults</button></div><div className="settings-grid"><div className="field"><label htmlFor="languages">Expected languages</label><div className="language-options"><label className={`language-chip ${preferences.transcription.languages.length===0?'chosen':''}`}><input type="checkbox" checked={preferences.transcription.languages.length===0} onChange={event=>changeTranscription({languages:event.target.checked?[]:['ro']})}/>Automatic</label>{LANGUAGES.map(lang=><label key={lang.code} className={`language-chip ${preferences.transcription.languages.includes(lang.code)?'chosen':''}`}><input type="checkbox" checked={preferences.transcription.languages.includes(lang.code)} onChange={event=>changeTranscription({languages:event.target.checked?[...preferences.transcription.languages,lang.code]:preferences.transcription.languages.filter(code=>code!==lang.code)})}/>{lang.label}</label>)}</div><input id="languages" aria-label="Expected language codes" key={preferences.transcription.languages.join(',')} defaultValue={preferences.transcription.languages.join(', ')} onBlur={event=>changeTranscription({languages:event.target.value.split(',').map(code=>code.trim().toLowerCase()).filter(Boolean)})} placeholder="Other ISO codes, separated by commas"/><span className="field-help">Use two-letter language codes. Automatic leaves out the language hint. Audio is never translated.</span></div><div className="field"><label htmlFor="context">Recording context</label><textarea id="context" maxLength={12000} value={preferences.transcription.prompt} onChange={event=>changeTranscription({prompt:event.target.value})} rows={3}/><span className="field-help">Briefly describe the lecture’s subject. This app allows up to 12,000 characters; the API may reject long context earlier.</span></div><div className="field"><label htmlFor="keywords">Vocabulary <span className="optional">Optional</span></label><textarea id="keywords" placeholder="Add a term on each line" rows={3} value={preferences.transcription.keywords.join('\n')} onChange={event=>changeTranscription({keywords:event.target.value.split('\n')})}/><span className="field-help">Names or specialist terms used in this lecture. One term per line; angle brackets are not allowed.</span></div><div className="field"><label className="toggle-label"><span><strong>Display text as it arrives</strong><small>Show streamed text while each section is transcribed.</small></span><input role="switch" className="switch" type="checkbox" checked={preferences.transcription.stream} onChange={event=>changeTranscription({stream:event.target.checked})}/></label><div className="preset-select"><label htmlFor="preset">Saved presets</label><select id="preset" defaultValue="" onChange={event=>{const preset=preferences.presets.find(item=>item.name===event.target.value);if(preset)changeTranscription(structuredClone(preset.settings));event.target.value='';}}><option value="" disabled>{preferences.presets.length?'Choose a preset':'No saved presets yet'}</option>{preferences.presets.map(preset=><option key={preset.name}>{preset.name}</option>)}</select></div></div></div><div className="settings-actions"><div className="preset-new"><input aria-label="Preset name" placeholder="Name this preset…" value={presetName} maxLength={80} onChange={event=>setPresetName(event.target.value)} onKeyDown={event=>{if(event.key==='Enter')addPreset();}}/><button className="button secondary small" disabled={!presetName.trim()} onClick={addPreset}>Save preset</button></div><button className="button primary small" onClick={()=>void savePreferences()}><Icon name={saved?'check':'settings'} size={16}/>{saved?'Settings saved':'Save settings'}</button></div></div>}
        </section>

        {selected && <section className="job-actions" aria-label="Transcription progress">
          <div><span className={`status-pill ${flagged?'needs-review':selected.status}`}><span className={`status-dot ${flagged?'needs-review':selected.status}`}/>{selected.status==='complete'&&flagged?'Finished · review needed':STATUS[selected.status]}</span>
            {selected.chunks.length>0&&<span className="section-progress">{finished} of {selected.chunks.length} sections processed · {completed} with text{noTextCount>0?` · ${noTextCount} without text`:''}</span>}
          </div>
          {STARTABLE.has(selected.status)&&(selected.status==='ready'||!selected.chunks.length||selected.chunks.some(chunk=>!isChunkFinished(chunk)))&&<button className="button primary" disabled={busy||!boot.ffmpegAvailable} onClick={()=>void startJobs([selected])}><Icon name={selected.status==='ready'?'wave':'refresh'} size={18}/>{selected.status==='ready'?'Transcribe':'Resume unfinished sections'}<Icon name="arrow" size={16}/></button>}
          {ACTIVE.has(selected.status)&&<button className="button secondary small" onClick={()=>void cancelJob(selected)} disabled={busy}><Icon name="stop" size={15}/>Cancel</button>}
          {selected.status==='ready'&&<p className="job-disclosure">Starting sends this recording to OpenAI. The estimate uses measured audio duration.</p>}
          {ACTIVE.has(selected.status)&&<p className="job-disclosure">{selected.status==='analyzing'?'Speech activity is being analyzed locally. This check does not send audio to an API, remove audio, or determine whether every word was transcribed.':`${selected.status==='retrying'?'A temporary API error occurred. The app is waiting before its next attempt.':'Finished sections are saved as they finish.'} Cancelling may still incur a charge for the current request.`}</p>}
          {['failed','paused','cancelled'].includes(selected.status)&&<p className="job-disclosure">Resuming sends only unfinished sections. Saved text and sections that returned no text are preserved and are not automatically resent. Interrupted requests may have been charged.</p>}
          {selected.error&&<div className="job-error" role="alert">{selected.error}</div>}
        </section>}
        {selected&&(flagged||selected.status==='complete')&&<section className={`review-summary ${flagged?'has-warnings':'review-information'}`} aria-label="Recording review">
          <div className="review-summary-heading"><Icon name={flagged?'warning':'headphones'} size={20}/><div><h2>{flagged?'Review this recording':'About the review checks'}</h2><p className="review-source">{selected.filename}</p></div>{flagged&&<span className="review-count">{reviewChunks.length} flagged {reviewChunks.length===1?'section':'sections'}</span>}</div>
          {reviewChunks.length>0&&<p className="review-counts">{noTextCount>0?`${noTextCount} ${noTextCount===1?'section returned':'sections returned'} no text. `:''}{reviewChunks.filter(chunk=>chunk.review?.kind==='short_text').length>0?`${reviewChunks.filter(chunk=>chunk.review?.kind==='short_text').length} ${reviewChunks.filter(chunk=>chunk.review?.kind==='short_text').length===1?'section has':'sections have'} unusually little text. `:''}Listen to the full intervals below; these are prompts to review, not confirmed omissions.</p>}
          {(selected.review?.analysisUnavailable||selected.review?.analysisNotRun)&&<p className="analysis-unavailable"><strong>{selected.review.analysisNotRun?'Local speech analysis was not run.':'Local speech analysis is unavailable.'}</strong> {selected.speech?.reason||'The review uses full section duration where speech evidence is unavailable.'} A nonempty result does not prove that the entire recording was transcribed.</p>}
          {reviewChunks.length>0&&<ul className="review-interval-list">{reviewChunks.map(chunk=><li key={chunk.id}><button className={`review-interval ${playbackRange?.chunkId===chunk.id?'selected-interval':''}`} onClick={()=>playReviewInterval(chunk)} aria-label={`Play review interval ${rangeLabel(chunk)} for ${selected.filename}`} aria-pressed={playbackRange?.chunkId===chunk.id}><Icon name="play" size={15}/><span><strong>{rangeLabel(chunk)}<span>{chunk.status==='no_text'?'No text returned':'Possibly incomplete'}</span></strong><small>{reviewEvidence(chunk)}</small></span></button></li>)}</ul>}
          {reviewChunks.length>0&&<p className="review-playback-help">{selected.audioAvailable?'Choose an interval to play the saved recording. Playback stops at the section’s end; this does not call OpenAI.':'Working audio is unavailable. Open your original recording and listen at the exact times shown. Review links still identify the relevant interval.'}</p>}
          <p className="review-explanation" lang="ro">{REVIEW_EXPLANATION}</p>
          <p className="review-export-note">App annotations are included in Copy all and TXT exports. The original returned text is unchanged; unfinished live text is excluded.</p>
        </section>}
        {importing && selected && <div className="import-status" role="status"><span className="spinner"/>{importing}</div>}

        <section className="transcript-card" aria-label="Transcript"><div className="transcript-toolbar"><div className="transcript-title"><Icon name="file" size={18}/><h2>Transcript</h2>{text&&<span className={`transcript-badge ${flagged?'needs-review':selected?.status==='complete'?'complete':''}`}>{flagged?'Review needed':selected?.status==='complete'?'Complete':'Partial'}</span>}</div><div className="transcript-tools"><div className="font-controls"><button onClick={()=>void savePreferences({...preferences,app:{...preferences.app,fontSize:Math.max(14,preferences.app.fontSize-1)}})} disabled={preferences.app.fontSize<=14} aria-label="Decrease transcript font size">A−</button><button onClick={()=>void savePreferences({...preferences,app:{...preferences.app,fontSize:Math.min(26,preferences.app.fontSize+1)}})} disabled={preferences.app.fontSize>=26} aria-label="Increase transcript font size">A+</button></div><span className="toolbar-divider"/><button className="tool-button" title="Copy saved transcript text and review annotations. Unfinished live text is excluded." disabled={!text} onClick={()=>void copyText()}><Icon name={copied?'check':'copy'} size={16}/><span>{copied?'Copied':'Copy all'}</span></button>{text&&selected?<a className="tool-button export-button" title="Download saved transcript text with review and unfinished-section annotations. Live draft text is excluded." href={`/api/jobs/${selected.id}/export`} download><Icon name="download" size={16}/><span>{selected.status==='complete'?'Export TXT':'Export partial TXT'}</span></a>:<button className="tool-button export-button" disabled><Icon name="download" size={16}/><span>Export TXT</span></button>}</div></div>
          {segments.length>0 ? <><div className="transcript-search"><Icon name="search" size={17}/><input aria-label="Search transcript" type="search" placeholder="Find a word or phrase…" value={search} onChange={event=>setSearch(event.target.value)}/>{query&&<span className="search-count">{matches?`${Math.min(searchIndex+1,matches)} of ${matches}`:'No matches'}</span>}{matches>1&&<><button className="icon-button previous-match" aria-label="Previous search match" onClick={()=>setSearchIndex(current=>(current-1+matches)%matches)}><Icon name="chevron" size={13}/></button><button className="icon-button" aria-label="Next search match" onClick={()=>setSearchIndex(current=>(current+1)%matches)}><Icon name="chevron" size={13}/></button></>}</div><div ref={transcriptRef} className="transcript-text" style={{fontSize:preferences.app.fontSize}} tabIndex={0} aria-label={flagged?'Transcript requiring review':selected?.status==='complete'?'Complete transcript':'Partial transcript'}>{segments.map((segment,index)=>segment.draft?<span key={index} className="transcript-live-draft"><small>Unfinished live text{segment.chunk?` · ${rangeLabel(segment.chunk)}`:''} · excluded from Copy all and TXT</small>{highlighted(segment.text)}</span>:segment.chunk&&isChunkFinished(segment.chunk)?<button key={index} className={`review-marker ${playbackRange?.chunkId===segment.chunk.id?'selected-interval':''}`} onClick={()=>playReviewInterval(segment.chunk!)} aria-pressed={playbackRange?.chunkId===segment.chunk.id} aria-label={`Review ${selected?.filename}, ${rangeLabel(segment.chunk)}: ${segment.chunk.status==='no_text'?'no text returned':'possibly incomplete transcript'}`}><Icon name="warning" size={17}/><span lang="ro">{highlighted(segment.text)}</span><Icon name="play" size={16}/></button>:segment.chunk?<span key={index} className={`unfinished-marker ${segment.chunk.status}`}><strong>{segment.chunk.status==='failed'?'API request failed':segment.chunk.status==='interrupted'?'Interrupted request':'Not yet processed'}</strong><span lang="ro">{highlighted(segment.text)}</span></span>:<span key={index} className="original-transcript-text">{highlighted(segment.text)}</span>)}{selected&&['uploading','transcribing'].includes(selected.status)&&<span className="live-indicator" aria-label="More text is being transcribed"/>}</div><div className="transcript-footer"><span>{new Intl.NumberFormat('en').format(orderedChunks.reduce((sum,chunk)=>sum+countWords(chunk.status==='complete'?chunk.text??'':''),0))} returned words<span className="footer-dot">·</span>{flagged?'App review notes included':selected?.status==='complete'?'Original returned text':'Partial · live text excluded from TXT'}</span><span>UTF-8 · Diacritics preserved</span></div></> : <div className="transcript-empty"><div className="paper-illustration"><div className="paper-top"><Icon name="wave" size={26}/><span/></div><div className="paper-line long"/><div className="paper-line"/><div className="paper-line short"/><span className="paper-spark"><Icon name="check" size={15}/></span></div><h3>{selected?.status==='analyzing'?'Checking speech activity on your Mac.':selected&&ACTIVE.has(selected.status)?'Listening, one section at a time.':'Your lecture, in your own words.'}</h3><p>{selected?.status==='analyzing'?'Local speech detection helps flag sections for review. It does not remove audio or guarantee a complete transcript.':selected&&ACTIVE.has(selected.status)?'Text will appear as it arrives. You can leave this tab open or come back later.':selected?'Choose Transcribe to turn this recording into text.':'Add a recording to begin. Your original transcript will appear here, ready to read and keep.'}</p><span className="empty-caption">{selected&&ACTIVE.has(selected.status)?<><span className="spinner"/> {STATUS[selected.status]}</>:<><Icon name="file" size={14}/>No summaries. No rewrites. Just the transcript.</>}</span></div>}
        </section>
        <footer className="page-footer"><span><Icon name="shield" size={13}/>Local workspace · Audio sent to OpenAI only when you start</span><span>{MODEL} <span>·</span> {money(boot.pricing.usdPerMinute).startsWith('<')?`$${boot.pricing.usdPerMinute}`:money(boot.pricing.usdPerMinute)}/min</span></footer>
      </div>
    </main>

    {dragging&&<div className="drop-overlay"><div><Icon name="upload" size={44}/><h2>Drop your recordings here</h2><p>Add one lecture or a whole week’s worth.</p></div></div>}
    {keyOpen&&<Dialog title={boot.keyConfigured?'Your OpenAI connection':'Welcome to Lecture Transcriber'} onClose={closeKey} className="key-dialog"><div className="dialog-content"><div className="key-illustration"><Icon name="key" size={27}/></div><h3>{boot.keyConfigured?'A secure connection, on your Mac.':'One small step. A clearer lecture.'}</h3><p>Add your OpenAI API key to transcribe with <code>{MODEL}</code>. Your key is stored in macOS Keychain and is never saved in your browser.</p>{boot.keyStorage==='unavailable'?<div className="notice error"><span>Secure key storage is unavailable. On your Mac, run First-time Setup.command, unlock your login Keychain, and restart the app. You can explore this workspace without a key.</span></div>:<form onSubmit={event=>{event.preventDefault();void saveKey();}}><label htmlFor="api-key">{boot.keyConfigured?'Replacement API key':'OpenAI API key'}</label><input id="api-key" type="password" autoComplete="off" spellCheck={false} value={keyInput} onChange={event=>setKeyInput(event.target.value)} placeholder="sk-…" disabled={keyBusy}/><p className="field-help">Create a key in your <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">OpenAI API account <Icon name="external" size={11}/></a>. Prepaid API credit is separate from a ChatGPT subscription.</p>{keyError&&<div className="notice error" role="alert">{keyError}</div>}<button type="submit" className="button primary full-width" disabled={!keyInput.trim()||keyBusy}>{keyBusy?<span className="spinner"/>:<Icon name="shield" size={17}/>}Save key securely</button></form>}<div className="key-privacy"><Icon name="shield" size={17}/><p>Your audio is sent to OpenAI only when you start a transcription. Transcripts and job history are saved locally.</p></div><button className="text-button full-width" onClick={closeKey}>{boot.keyConfigured?'Back to workspace':'Explore the workspace first'}</button></div></Dialog>}
    {appOpen&&<Dialog title="App settings" onClose={closeApp} className="app-dialog"><div className="dialog-content">{notice?.type==='error'&&<div className="notice error" role="alert">{notice.text}</div>}<section className="app-settings-section"><h3>Make it feel like home</h3><label>Appearance</label><div className="theme-options">{(['system','light','dark'] as const).map(theme=><button key={theme} className={preferences.app.theme===theme?'chosen':''} aria-pressed={preferences.app.theme===theme} onClick={()=>changeApp({theme})}><Icon name={theme==='system'?'monitor':theme==='light'?'sun':'moon'} size={18}/>{theme[0].toUpperCase()+theme.slice(1)}</button>)}</div></section><section className="app-settings-section"><h3>Audio & recovery</h3><div className="settings-grid compact"><div className="field"><label htmlFor="chunk-minutes">Section length (minutes)</label><input id="chunk-minutes" type="number" min={1} max={10} value={preferences.app.chunkMinutes} onChange={event=>changeApp({chunkMinutes:Number(event.target.value)})}/><span className="field-help">Short sections make long lectures easier to resume. A nearby pause is used when possible.</span></div><div className="field"><label htmlFor="retries">Automatic retries</label><input id="retries" type="number" min={0} max={5} value={preferences.app.retries} onChange={event=>changeApp({retries:Number(event.target.value)})}/><span className="field-help">Retries per section for temporary failures. Each attempt may incur a charge.</span></div></div><label className="toggle-label"><span><strong>Keep working audio after completion</strong><small>Off by default to save space. Your original recording is always untouched.</small></span><input className="switch" role="switch" type="checkbox" checked={preferences.app.keepAudio} onChange={event=>changeApp({keepAudio:event.target.checked})}/></label></section><section className="app-settings-section"><h3>OpenAI connection</h3><div className="connection-row"><span className={`status-pill ${boot.keyConfigured?'complete':'paused'}`}><span className="status-dot"/>{boot.keyConfigured?'Key securely saved':'No API key connected'}</span><button className="text-button" onClick={()=>{closeApp();setKeyOpen(true);}}>{boot.keyConfigured?'Replace key':'Add key'}</button>{boot.keyConfigured&&<button className="text-button danger-text" onClick={()=>void removeKey()} disabled={keyBusy||active}>Remove</button>}</div><p className="field-help">Key removal is available when no lectures are processing.</p></section><section className="app-settings-section"><h3>Local usage estimate</h3><div className="usage-row"><strong>{money(boot.usage.estimatedUsd)}</strong><span>{boot.usage.requests} recorded request{boot.usage.requests===1?'':'s'}</span></div><p className="field-help">This is a local estimate, not your OpenAI account balance. {boot.usage.uncertainRequests>0?`${boot.usage.uncertainRequests} interrupted or timed-out request(s) may have been charged. `:''}Retries can increase cost.</p><p className="field-help">Rate: ${boot.pricing.usdPerMinute}/minute · Verified {boot.pricing.verifiedOn}. <a href={boot.pricing.source} target="_blank" rel="noreferrer">View pricing <Icon name="external" size={11}/></a></p><label>Saved data location</label><code className="data-path">{boot.dataDir}</code></section><div className="app-settings-footer"><button className="text-button" onClick={()=>{setPreferences(current=>({...current,app:structuredClone(DEFAULTS.app)}));setSaved(false);}}>Reset app defaults</button><button className="button primary small" onClick={()=>void savePreferences()}><Icon name={saved?'check':'settings'} size={15}/>{saved?'Settings saved':'Save settings'}</button></div><button className="stop-app" onClick={()=>{closeApp();setStopOpen(true);}}><Icon name="stop" size={16}/>Stop Lecture Transcriber</button></div></Dialog>}
    {deleteId&&<Dialog title="Delete this lecture?" onClose={closeDelete}><div className="dialog-content"><p>This removes the lecture’s transcript, saved responses, and working audio from this app. Your original recording stays untouched.</p><p><strong>{jobs.find(job=>job.id===deleteId)?.filename}</strong></p><div className="dialog-actions"><button className="button secondary" onClick={closeDelete}>Keep lecture</button><button className="button danger" disabled={busy} onClick={()=>void removeJob()}>Delete from app</button></div></div></Dialog>}
    {stopOpen&&<Dialog title="Stop Lecture Transcriber?" onClose={closeStop}><div className="dialog-content"><p>Your saved transcripts will be here when you return. {active?'Unfinished jobs will be paused and completed sections will be preserved. An in-flight API request may still incur a charge.':'Double-click the launcher to open the app again.'}</p><div className="dialog-actions"><button className="button secondary" onClick={closeStop}>Keep open</button><button className="button primary" disabled={busy} onClick={()=>void stopApp()}>Stop app</button></div></div></Dialog>}
  </div>;
}
