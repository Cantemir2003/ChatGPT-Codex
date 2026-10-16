export type JobStatus = 'ready'|'queued'|'preparing'|'analyzing'|'uploading'|'transcribing'|'retrying'|'paused'|'failed'|'cancelled'|'complete';
export interface TranscriptionSettings { languages: string[]; prompt: string; keywords: string[]; stream: boolean; }
export interface AppSettings { theme: 'system'|'light'|'dark'; fontSize: number; chunkMinutes: number; retries: number; keepAudio: boolean; }
export interface Preferences { transcription: TranscriptionSettings; app: AppSettings; presets: {name:string;settings:TranscriptionSettings}[]; }
export interface AudioInfo {duration:number;size:number;codec:string;sampleRate:number;channels:number;format:string;}
export interface Attempt {startedAt:string;endedAt?:string;outcome:'pending'|'success'|'failed'|'uncertain';estimatedUsd:number;}
export interface SpeechAnalysis {
 status:'complete'|'unavailable'; model:string; version:string;
 intervals:{start:number;end:number}[]; speechSeconds:number; analyzedSeconds:number; reason?:string;
}
export interface ChunkReview {
 kind:'missing_text'|'short_text'; basis:'speech'|'duration'; wordCount:number;
 speechSeconds?:number; wordsPerMinute?:number;
}
export interface JobReview {
 needsReview:boolean; missingTextCount:number; shortTextCount:number;
 analysisUnavailable:boolean; analysisNotRun:boolean;
}
export interface Chunk {
 id:string;index:number;start:number;end:number;file:string;
 status:'pending'|'complete'|'no_text'|'failed'|'interrupted';text?:string;attempts:Attempt[];
 noTextReason?:'empty'|'whitespace'|'missing_text'|'invalid_text';review?:ChunkReview;
}
export interface Job {id:string;filename:string;createdAt:string;updatedAt:string;status:JobStatus;audio:AudioInfo;settings:TranscriptionSettings;appSettings:AppSettings;chunks:Chunk[];text:string;partialText:string;error?:string;sourceFile:string;audioAvailable:boolean;estimatedUsd:number;speech?:SpeechAnalysis;review?:JobReview;}
export interface Bootstrap {csrfToken:string;keyConfigured:boolean;keyStorage:'macos-keychain'|'unavailable';ffmpegAvailable:boolean;dataDir:string;preferences:Preferences;jobs:Job[];pricing:{usdPerMinute:number;verifiedOn:string;source:string};usage:{estimatedUsd:number;uncertainRequests:number;requests:number};}
