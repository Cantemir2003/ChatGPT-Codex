export type JobStatus = 'ready'|'queued'|'preparing'|'uploading'|'transcribing'|'retrying'|'paused'|'failed'|'cancelled'|'complete';
export interface TranscriptionSettings { languages: string[]; prompt: string; keywords: string[]; stream: boolean; }
export interface AppSettings { theme: 'system'|'light'|'dark'; fontSize: number; chunkMinutes: number; retries: number; keepAudio: boolean; }
export interface Preferences { transcription: TranscriptionSettings; app: AppSettings; presets: {name:string;settings:TranscriptionSettings}[]; }
export interface AudioInfo {duration:number;size:number;codec:string;sampleRate:number;channels:number;format:string;}
export interface Attempt {startedAt:string;endedAt?:string;outcome:'pending'|'success'|'failed'|'uncertain';estimatedUsd:number;}
export interface Chunk {id:string;index:number;start:number;end:number;file:string;status:'pending'|'complete';text?:string;attempts:Attempt[];}
export interface Job {id:string;filename:string;createdAt:string;updatedAt:string;status:JobStatus;audio:AudioInfo;settings:TranscriptionSettings;appSettings:AppSettings;chunks:Chunk[];text:string;partialText:string;error?:string;sourceFile:string;audioAvailable:boolean;estimatedUsd:number;}
export interface Bootstrap {csrfToken:string;keyConfigured:boolean;keyStorage:'macos-keychain'|'unavailable';ffmpegAvailable:boolean;dataDir:string;preferences:Preferences;jobs:Job[];pricing:{usdPerMinute:number;verifiedOn:string;source:string};usage:{estimatedUsd:number;uncertainRequests:number;requests:number};}
