import {describe, expect, it} from 'vitest';
import {DEFAULTS} from '../shared/config.js';
import type {Chunk, Job, SpeechAnalysis} from '../shared/types.js';
import {applyResponse, assembleTranscript, chunkAnnotation, formatTimestamp, normalizeSpeech, rawTranscript, refreshReview, speechInRange} from '../shared/review.js';

function chunk(index:number,start:number,end:number,response:unknown):Chunk {
 const value:Chunk={id:`chunk-${String(index).padStart(6,'0')}`,index,start,end,file:'',status:'pending',attempts:[]};
 applyResponse(value,response);
 return value;
}
function job(chunks:Chunk[],speech?:SpeechAnalysis):Job {
 return {id:'fixture',filename:'Curs — țesuturi.m4a',createdAt:'',updatedAt:'',status:'complete',
  audio:{duration:Math.max(0,...chunks.map(c=>c.end)),size:1,codec:'aac',sampleRate:48000,channels:1,format:'mov'},
  settings:structuredClone(DEFAULTS.transcription),appSettings:structuredClone(DEFAULTS.app),
  sourceFile:'',audioAvailable:true,estimatedUsd:0,chunks,text:'',partialText:'',speech};
}
const analysis=(intervals:{start:number;end:number}[],duration=300):SpeechAnalysis=>({status:'complete',model:'test-vad',version:'fixture',
 intervals,speechSeconds:speechInRange(intervals,0,duration),analyzedSeconds:duration});

describe('reviewing model responses without inventing speech or text',()=>{
 it.each([
  [{text:''},'empty'], [{text:' \n\t\r '},'whitespace'], [{},'missing_text'],
  [{text:null},'invalid_text'],[{text:34},'invalid_text'], [null,'missing_text'],
 ] as const)('classifies a successful unusable response %j without calling it silence',(response,reason)=>{
  const c=chunk(0,0,0.35,response);const j=job([c],analysis([],0.35));refreshReview(j);
  expect(c.status).toBe('no_text');expect(c.noTextReason).toBe(reason);
  expect(j.review?.needsReview).toBe(true);expect(j.review?.missingTextCount).toBe(1);
  const rendered=assembleTranscript(j);
  expect(rendered).toContain('FĂRĂ TRANSCRIERE');expect(rendered).toContain('00:00:00–00:00:00.350');
  expect(rendered).not.toMatch(/liniște|fără vorbire/i);
 });

 it('keeps a missing middle section and a short final section in chronological export with real source times',()=>{
  const first=chunk(0,0,60,{text:'  Știință. Știință.\n'});
  const middle=chunk(1,60,120,{text:' \t'});
  const last=chunk(2,120,123.456,{text:''});
  const j=job([last,first,middle],analysis([],123.456));refreshReview(j);
  const rendered=assembleTranscript(j);
  expect(rendered.startsWith(first.text!)).toBe(true);
  expect(rendered.indexOf('00:01:00–00:02:00')).toBeLessThan(rendered.indexOf('00:02:00–00:02:03.456'));
  expect(rendered.match(/FĂRĂ TRANSCRIERE/g)).toHaveLength(2);
  expect(rendered.match(/Curs — țesuturi.m4a/g)).toHaveLength(2);
  expect(rawTranscript(j)).toBe('  Știință. Știință.\n\n\n \t\n\n');
 });

 it('flags low text against detected speech, preserving every returned character',()=>{
  const text='  Rădăcina dintelui.\n';const c=chunk(0,0,120,{text});
  const j=job([c],analysis([{start:10,end:100}],120));refreshReview(j);
  expect(c.review).toMatchObject({kind:'short_text',basis:'speech',wordCount:2,speechSeconds:90});
  expect(c.review?.wordsPerMinute).toBeCloseTo(2*60/90);
  expect(assembleTranscript(j)).toContain('Transcriere posibil incompletă');
  expect(assembleTranscript(j).endsWith(text)).toBe(true);
  expect(rawTranscript(j)).toBe(text);
 });

 it('does not mistake a long pause for evidence of missing speech or mark short sections by rate alone',()=>{
  const c=chunk(0,0,300,{text:'Bună ziua.'});
  const j=job([c],analysis([{start:0,end:8}],300));refreshReview(j);
  expect(c.review).toBeUndefined();expect(j.review?.needsReview).toBe(false);
  expect(assembleTranscript(j)).toBe('Bună ziua.');
 });

 it('uses a clearly identified duration fallback and warns when local analysis fails',()=>{
  const c=chunk(0,0,180,{text:'O propoziție.'});
  const j=job([c],{status:'unavailable',model:'silero-vad',version:'x',intervals:[],speechSeconds:0,analyzedSeconds:0,reason:'Unavailable'});
  refreshReview(j);
  expect(c.review).toMatchObject({kind:'short_text',basis:'duration'});
  expect(c.review?.speechSeconds).toBeUndefined();
  expect(j.review).toMatchObject({needsReview:true,analysisUnavailable:true});
  expect(assembleTranscript(j)).toContain('VERIFICARE AUDIO INDISPONIBILĂ');
 });

 it('migrates old empty completed responses and warns that historical audio was not analyzed',()=>{
  const c=chunk(0,0,60,{text:' \n'});c.status='complete';delete c.noTextReason;
  const j=job([c]);refreshReview(j);
  expect(c.status).toBe('no_text');expect(c.noTextReason).toBe('whitespace');
  expect(j.review?.analysisNotRun).toBe(true);
  expect(assembleTranscript(j)).toContain('nu a fost efectuată');
 });

 it('never represents errors, interrupted requests, or unprocessed intervals as empty successful responses',()=>{
  const j=job(['failed','interrupted','pending'].map((status,index)=>({...chunk(index,index*60,(index+1)*60,{text:''}),status:status as Chunk['status']})),analysis([]));
  refreshReview(j);const text=assembleTranscript(j);
  expect(text).toContain('EROARE API / CERERE EȘUATĂ');expect(text).toContain('ÎNTRERUPT');expect(text).toContain('NEPROCESAT');
  expect(text).not.toContain('FĂRĂ TRANSCRIERE');expect(j.review?.missingTextCount).toBe(0);
 });

 it('measures clipped speech intervals only once at real chunk boundaries',()=>{
  expect(speechInRange([{start:0,end:65},{start:60,end:75},{start:90,end:110}],60,100)).toBe(25);
  expect(formatTimestamp(3661.123)).toBe('01:01:01.123');
  const c=chunk(0,0,60,{text:''});
  expect(chunkAnnotation({filename:'one\n[two].m4a'},c)).toContain('one  two .m4a');
 });

 it.each([null,{status:'other'},{...analysis([],120),intervals:[null]},
  {...analysis([],120),intervals:[{start:1,end:Infinity}]},analysis([],30)])('turns invalid or incomplete saved VAD metadata into a visible unavailable warning: %j',value=>{
  const j=job([chunk(0,0,120,{text:'Text returnat.'})]);j.speech=value as SpeechAnalysis;
  refreshReview(j);
  expect(j.speech?.status).toBe('unavailable');expect(j.review?.needsReview).toBe(true);
  expect(j.review?.analysisUnavailable).toBe(true);
 });

 it('recomputes speech duration from interval union rather than trusting a saved counter',()=>{
  const result=normalizeSpeech({...analysis([{start:0,end:60},{start:50,end:90}],120),speechSeconds:0},120);
  expect(result?.speechSeconds).toBe(90);expect(result?.intervals).toEqual([{start:0,end:90}]);
 });

 it('keeps a damaged no-text response visible instead of crashing on its non-string saved text',()=>{
  const c=chunk(0,0,120,{text:''});(c as unknown as {text:unknown}).text={unexpected:true};
  const j=job([c],analysis([],120));refreshReview(j);
  expect(c.status).toBe('no_text');expect(c.noTextReason).toBe('invalid_text');
  expect(rawTranscript(j)).toBe('');expect(assembleTranscript(j)).toContain('format neașteptat');
 });
});
