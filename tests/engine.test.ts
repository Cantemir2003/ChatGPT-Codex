import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../server/engine.js';
import { Store } from '../server/store.js';
import { DEFAULTS, estimateCost } from '../shared/config.js';
import type { AudioInfo, Chunk, Job, SpeechAnalysis } from '../shared/types.js';
import type { Transcriber, TranscribeResult } from '../server/transcribe.js';

let folder: string;
let store: Store;
const fakeKey = 'sk-test-never-sent-to-a-network';
const audio: AudioInfo = { duration: 120, size: 5, codec: 'aac', sampleRate: 48000, channels: 1, format: 'mov,mp4,m4a' };
const quietAnalysis = (duration = audio.duration): SpeechAnalysis => ({ status: 'complete', model: 'silero-vad', version: '6.2.3', intervals: [], speechSeconds: 0, analyzedSeconds: duration });

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'lecture-engine-'));
  store = new Store(folder);
});
afterEach(async () => { await rm(folder, { recursive: true, force: true }); });

function part(index: number, text?: string): Chunk {
  return {
    id: `chunk-${String(index).padStart(6, '0')}`, index, start: index * 60, end: (index + 1) * 60,
    file: '', status: text === undefined ? 'pending' : 'complete', text, attempts: [],
  };
}

async function lecture(chunks: Chunk[] = [part(0), part(1)]): Promise<Job> {
  const id = randomUUID();
  const now = new Date().toISOString();
  const audioDirectory = join(store.jobDir(id), 'audio');
  await mkdir(audioDirectory, { recursive: true });
  for (const chunk of chunks) {
    chunk.file = join(audioDirectory, `${chunk.id}.wav`);
    await writeFile(chunk.file, 'audio');
  }
  const job: Job = {
    id, filename: 'Curs de medicină dentară.m4a', createdAt: now, updatedAt: now, status: 'ready', audio,
    settings: structuredClone(DEFAULTS.transcription), appSettings: { ...DEFAULTS.app, keepAudio: true, retries: 0 },
    chunks, text: '', partialText: '', sourceFile: join(store.jobDir(id), 'source.m4a'), audioAvailable: true,
    estimatedUsd: estimateCost(audio.duration),
  };
  store.save(job);
  await writeFile(job.sourceFile, 'audio');
  return job;
}

function engine(transcriber: Transcriber, overrides: Partial<ConstructorParameters<typeof Engine>[1]> = {}) {
  return new Engine(store, { key: async () => fakeKey, transcriber, analyze: async (_source, info) => quietAnalysis(info.duration), backoff: async () => {}, ...overrides });
}
async function start(worker: Engine, job: Job) { await worker.start(job.id, job.settings, job.appSettings); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('persistent transcription engine', () => {
  it('assembles in audio order and preserves Romanian diacritics, repetitions, and whitespace exactly', async () => {
    const first = '  Și, și... rădăcina dintelui.\n';
    const second = '\nȚesutul e — e important.  ';
    const job = await lecture([part(1), part(0)]);
    const calls: string[] = [];
    const worker = engine(async input => {
      calls.push(input.file);
      input.onDelta('a provisional fragment');
      input.onPhase('transcribing');
      return { text: input.file.endsWith('chunk-000000.wav') ? first : second, usage: { input_tokens: 20 } };
    });
    await start(worker, job); await worker.idle();
    expect(calls).toEqual([...job.chunks].sort((a, b) => a.index - b.index).map(chunk => chunk.file));
    expect(job.status).toBe('complete');
    expect(job.text).toBe(`${first}\n\n${second}`);
    expect(job.partialText).toBe('');
    expect(await readFile(join(store.jobDir(job.id), 'transcript.txt'), 'utf8')).toBe(job.text);
    const response = JSON.parse(await readFile(join(store.jobDir(job.id), 'responses', 'chunk-000000.json'), 'utf8'));
    expect(response).toEqual({ text: first, usage: { input_tokens: 20 } });
  });

  it('resumes only unfinished sections and keeps the original settings snapshot', async () => {
    const job = await lecture();
    const seenSettings: unknown[] = [];
    let fail = true;
    const send = vi.fn<Transcriber>(async input => {
      seenSettings.push(structuredClone(input.settings));
      if (input.file.endsWith('chunk-000001.wav') && fail) throw Object.assign(new Error('private API response'), { status: 503 });
      return { text: input.file.endsWith('chunk-000000.wav') ? 'Prima secțiune.' : 'A doua secțiune.' };
    });
    const worker = engine(send);
    await start(worker, job); await worker.idle();
    expect(job.status).toBe('failed');
    expect(job.text).toContain('Prima secțiune.');
    expect(job.text).toContain('EROARE API');
    expect(await readFile(join(store.jobDir(job.id), 'raw-transcript.txt'), 'utf8')).toBe('Prima secțiune.');
    expect(job.chunks[0].attempts).toHaveLength(1);
    const savedSettings = structuredClone(job.settings);
    store.savePreferences({ ...DEFAULTS, transcription: { ...DEFAULTS.transcription, prompt: 'Changed for future lectures', languages: ['en'] } });
    fail = false;
    await worker.start(job.id, { ...DEFAULTS.transcription, prompt: 'Should not replace a resumed lecture' }, DEFAULTS.app);
    await worker.idle();
    expect(send).toHaveBeenCalledTimes(3);
    expect(job.chunks[0].attempts).toHaveLength(1);
    expect(job.chunks[1].attempts).toHaveLength(2);
    expect(seenSettings).toEqual([savedSettings, savedSettings, savedSettings]);
    expect(job.appSettings.retries).toBe(0);
    expect(job.status).toBe('complete');
    expect(job.text).toBe('Prima secțiune.\n\nA doua secțiune.');
  });

  it('recovers a durably saved final response when the manifest commit was interrupted', async () => {
    const job = await lecture([part(0)]);
    job.status = 'transcribing';
    job.partialText = 'An unfinished alternative';
    job.chunks[0].attempts.push({ startedAt: new Date().toISOString(), outcome: 'pending', estimatedUsd: estimateCost(60) });
    store.save(job);
    store.saveResponse(job, job.chunks[0].id, { text: 'Știință. Știință.', usage: { seconds: 60 } });
    const reopened = new Store(folder);
    const recovered = reopened.get(job.id);
    expect(recovered.status).toBe('complete');
    expect(recovered.chunks[0].text).toBe('Știință. Știință.');
    expect(recovered.text).toContain('Știință. Știință.');
    expect(recovered.review?.analysisNotRun).toBe(true);
    expect(recovered.partialText).toBe('');
    expect(recovered.chunks[0].attempts[0].outcome).toBe('success');
    expect(reopened.usage()).toEqual({ requests: 1, uncertainRequests: 0, estimatedUsd: estimateCost(60) });
    const send = vi.fn<Transcriber>(async () => ({ text: 'must not run' }));
    const worker = new Engine(reopened, { key: async () => fakeKey, transcriber: send });
    await worker.start(job.id); await worker.idle();
    expect(send).not.toHaveBeenCalled();
  });

  it('never promotes a streamed fragment to completed text after interruption', async () => {
    const job = await lecture([part(0, 'Completed text.'), part(1)]);
    job.status = 'transcribing';
    job.partialText = 'Partial Țesut';
    job.chunks[1].attempts.push({ startedAt: new Date().toISOString(), outcome: 'pending', estimatedUsd: estimateCost(60) });
    store.save(job);
    const reopened = new Store(folder);
    const recovered = reopened.get(job.id);
    expect(recovered.status).toBe('paused');
    expect(recovered.chunks[1].status).toBe('interrupted');
    expect(recovered.text).toContain('Completed text.');
    expect(recovered.text).toContain('ÎNTRERUPT');
    expect(recovered.text).not.toContain('Partial Țesut');
    expect(await readFile(join(reopened.jobDir(job.id), 'raw-transcript.txt'), 'utf8')).toBe('Completed text.');
    expect(reopened.usage().uncertainRequests).toBe(1);
  });

  it.each([429, 500, 503, 408])('bounds retries for HTTP %i and persists every attempt', async status => {
    const job = await lecture([part(0)]); job.appSettings.retries = 2;
    const send = vi.fn<Transcriber>(async () => { throw Object.assign(new Error('private server details'), { status }); });
    const backoff = vi.fn(async () => {});
    const worker = engine(send, { backoff });
    await start(worker, job); await worker.idle();
    expect(send).toHaveBeenCalledTimes(3);
    expect(backoff).toHaveBeenCalledTimes(2);
    expect(job.status).toBe('failed');
    expect(job.chunks[0].attempts).toHaveLength(3);
    expect(job.chunks[0].attempts.every(a => a.outcome === (status === 429 ? 'failed' : 'uncertain'))).toBe(true);
    expect(store.usage().requests).toBe(3);
    expect(job.error).not.toContain('private server details');
  });

  it.each([
    { status: 401 }, { status: 429, code: 'insufficient_quota' }, { status: 429, code: 'billing_hard_limit_reached' },
  ])('stops queued lectures after authentication or billing errors: %j', async error => {
    const first = await lecture([part(0)]);
    const second = await lecture([part(0)]);
    const gate = deferred<TranscribeResult>();
    const entered = deferred<void>();
    const send = vi.fn<Transcriber>(async () => { entered.resolve(); return gate.promise; });
    const worker = engine(send);
    await start(worker, first); await entered.promise;
    await start(worker, second);
    expect(second.status).toBe('queued');
    gate.reject(Object.assign(new Error('private API key'), error));
    await worker.idle();
    expect(first.status).toBe('failed');
    expect(second.status).toBe('paused');
    expect(second.chunks[0].attempts).toHaveLength(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(first.error).not.toContain('private API key');
    expect(second.error).not.toContain('private API key');
  });

  it('cancels in-flight work while preserving completed text and uncertain cost', async () => {
    const job = await lecture([part(0, 'Păstrat exact.'), part(1)]);
    const entered = deferred<void>();
    const worker = engine(async input => {
      input.onDelta('fragment that is not final');
      input.onPhase('transcribing');
      entered.resolve();
      return new Promise((_, reject) => input.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
    });
    await start(worker, job); await entered.promise;
    worker.cancel(job.id); await worker.idle();
    expect(job.status).toBe('cancelled');
    expect(job.text).toContain('Păstrat exact.');
    expect(job.text).toContain('ÎNTRERUPT');
    expect(job.chunks[0].status).toBe('complete');
    expect(job.chunks[1].status).toBe('interrupted');
    expect(job.chunks[1].attempts[0].outcome).toBe('uncertain');
    expect(store.usage().uncertainRequests).toBe(1);
    expect((await stat(job.sourceFile)).isFile()).toBe(true);
  });

  it('retains cumulative request usage after deleting a lecture and reopening the app', async () => {
    const job = await lecture([part(0)]);
    const worker = engine(async () => ({ text: 'Încă o lecție.' }));
    await start(worker, job); await worker.idle();
    const usage = store.usage();
    expect(usage).toEqual({ requests: 1, uncertainRequests: 0, estimatedUsd: estimateCost(60) });
    await worker.remove(job.id);
    expect(store.list()).toHaveLength(0);
    expect(store.usage()).toEqual(usage);
    const reopened = new Store(folder);
    expect(reopened.list()).toHaveLength(0);
    expect(reopened.usage()).toEqual(usage);
  });

  it('removes local audio only after every section succeeds, preserving transcript and raw responses', async () => {
    const job = await lecture([part(0)]); job.appSettings.keepAudio = false;
    const worker = engine(async () => ({ text: 'Rezultat final.' }));
    await start(worker, job); await worker.idle();
    expect(job.status).toBe('complete');
    expect(job.audioAvailable).toBe(false);
    await expect(stat(job.sourceFile)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(store.jobDir(job.id), 'transcript.txt'), 'utf8')).toBe('Rezultat final.');
    expect(JSON.parse(await readFile(join(store.jobDir(job.id), 'responses', 'chunk-000000.json'), 'utf8')).text).toBe('Rezultat final.');
    const recovered = new Store(folder).get(job.id);
    expect(recovered.status).toBe('complete');
    expect(recovered.audioAvailable).toBe(false);
  });

  it('pauses active and queued work on app shutdown without submitting the next lecture', async () => {
    const first = await lecture([part(0)]);
    const second = await lecture([part(0)]);
    const entered = deferred<void>();
    const send = vi.fn<Transcriber>(async input => {
      entered.resolve();
      return new Promise((_, reject) => input.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
    });
    const worker = engine(send);
    await start(worker, first); await entered.promise;
    await start(worker, second);
    await worker.stop();
    expect(first.status).toBe('paused');
    expect(second.status).toBe('paused');
    expect(send).toHaveBeenCalledTimes(1);
    expect(first.chunks[0].attempts[0].outcome).toBe('uncertain');
    expect(second.chunks[0].attempts).toHaveLength(0);
    expect(worker.busy).toBe(false);
    await expect(worker.start(second.id)).rejects.toThrow('The app is stopping.');
  });

  it('preserves a malformed manifest and fails visibly instead of silently losing history', async () => {
    const job = await lecture();
    const manifest = join(store.jobDir(job.id), 'manifest.json');
    const truncated = '{"id":"' + job.id;
    await writeFile(manifest, truncated);
    expect(() => new Store(folder)).toThrow('A saved lecture manifest could not be read.');
    expect(await readFile(manifest, 'utf8')).toBe(truncated);
    expect((await stat(job.sourceFile)).isFile()).toBe(true);
  });

  it('does not repeat a successful paid API request when saving its response fails locally', async () => {
    const job = await lecture([part(0)]); job.appSettings.retries = 2;
    const send = vi.fn<Transcriber>(async () => ({ text: 'Successful API response.' }));
    const backoff = vi.fn(async () => {});
    vi.spyOn(store, 'saveResponse').mockImplementation(() => { throw new Error('ENOSPC /private/local-directory sk-private-secret'); });
    const worker = engine(send, { backoff });
    await start(worker, job); await worker.idle();
    expect(send).toHaveBeenCalledOnce();
    expect(backoff).not.toHaveBeenCalled();
    expect(job.chunks[0].attempts).toHaveLength(1);
    expect(job.error).not.toContain('/private/local-directory');
    expect(job.error).not.toContain('sk-private-secret');
  });

  it('stops retries when persisting streaming progress fails locally', async () => {
    const job = await lecture([part(0)]); job.appSettings.retries = 2;
    const save = store.save.bind(store);
    let failOnce = true;
    vi.spyOn(store, 'save').mockImplementation(value => {
      if (value.status === 'transcribing' && failOnce) {
        failOnce = false;
        throw new Error('ENOSPC /private/storage');
      }
      save(value);
    });
    const send = vi.fn<Transcriber>(async input => {
      input.onPhase('transcribing');
      return { text: 'This final result was not reached.' };
    });
    const backoff = vi.fn(async () => {});
    const worker = engine(send, { backoff });
    await start(worker, job); await worker.idle();
    expect(send).toHaveBeenCalledOnce();
    expect(backoff).not.toHaveBeenCalled();
    expect(job.status).toBe('failed');
    expect(job.text).toContain('ÎNTRERUPT');
    expect(await readFile(join(store.jobDir(job.id), 'raw-transcript.txt'), 'utf8')).toBe('');
    expect(job.chunks[0].attempts[0].outcome).toBe('uncertain');
    expect(job.error).toContain('Local progress could not be saved.');
    expect(job.error).not.toContain('/private/storage');
  });

  it('imports without submitting audio and snapshots settings when transcription starts', async () => {
    const uploaded = join(folder, 'upload.m4a'); await writeFile(uploaded, 'audio');
    const send = vi.fn<Transcriber>(async () => ({ text: 'Text.' }));
    const prepare = vi.fn(async (_source: string, outputDirectory: string) => {
      await mkdir(outputDirectory, { recursive: true });
      const chunk = part(0); chunk.file = join(outputDirectory, `${chunk.id}.wav`);
      await writeFile(chunk.file, 'audio');
      return [chunk];
    });
    const worker = engine(send, { inspect: async () => audio, prepare });
    const job = await worker.importAudio(uploaded, 'Curs.m4a');
    expect(job.status).toBe('ready');
    expect(send).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    const selected = { ...DEFAULTS.transcription, languages: ['ro', 'en'], prompt: 'Odontologie', keywords: ['ameloblast'] };
    await worker.start(job.id, selected, { ...DEFAULTS.app, keepAudio: true });
    selected.languages.push('de'); selected.keywords.push('later change');
    await worker.idle();
    expect(job.settings.languages).toEqual(['ro', 'en']);
    expect(job.settings.keywords).toEqual(['ameloblast']);
    expect(prepare).toHaveBeenCalledOnce();
    expect(job.status).toBe('complete');
  });
});

describe('speech analysis and review persistence', () => {
  it('analyzes imported audio once before the first API request and reuses the saved analysis on resume', async () => {
    const uploaded = join(folder, 'upload.m4a'); await writeFile(uploaded, 'original audio unchanged');
    const order: string[] = [];
    const prepare = vi.fn(async (_source: string, outputDirectory: string) => {
      order.push('prepare'); await mkdir(outputDirectory, { recursive: true });
      const chunk = part(0); chunk.file = join(outputDirectory, `${chunk.id}.wav`);
      await writeFile(chunk.file, 'prepared audio unchanged'); return [chunk];
    });
    const analyze = vi.fn(async (_source: string, info: AudioInfo) => { order.push('analyze'); return quietAnalysis(info.duration); });
    let shouldFail = true;
    const send = vi.fn<Transcriber>(async () => {
      order.push('send');
      const saved = JSON.parse(await readFile(join(store.jobDir(job.id), 'manifest.json'), 'utf8'));
      expect(saved.speech.status).toBe('complete');
      if (shouldFail) throw Object.assign(new Error('API error'), { status: 503 });
      return { text: 'Text păstrat.' };
    });
    const worker = engine(send, { inspect: async () => audio, prepare, analyze });
    const job = await worker.importAudio(uploaded, 'Curs.m4a');
    expect(order).toEqual([]);
    await worker.start(job.id, job.settings, { ...job.appSettings, keepAudio: true, retries: 0 }); await worker.idle();
    expect(order).toEqual(['prepare', 'analyze', 'send']);
    expect(job.status).toBe('failed');
    shouldFail = false;
    await start(worker, job); await worker.idle();
    expect(order).toEqual(['prepare', 'analyze', 'send', 'send']);
    expect(analyze).toHaveBeenCalledOnce();
    expect(await readFile(job.sourceFile, 'utf8')).toBe('original audio unchanged');
    expect(await readFile(job.chunks[0].file, 'utf8')).toBe('prepared audio unchanged');
    expect(new Store(folder).get(job.id).speech).toEqual(job.speech);
  });

  it.each([
    [{ text: '' }, 'empty'],
    [{ text: ' \t\n ' }, 'whitespace'],
    [{ usage: { seconds: 60 } }, 'missing_text'],
    [{ text: null, usage: { seconds: 60 } }, 'invalid_text'],
    [{ text: 123 }, 'invalid_text'],
  ] as const)('keeps successful no-text response %j terminal without automatic or manual resubmission', async (response, reason) => {
    const job = await lecture([part(0)]); job.appSettings = { ...job.appSettings, retries: 5, keepAudio: false };
    const send = vi.fn<Transcriber>(async () => response);
    const backoff = vi.fn(async () => {});
    const worker = engine(send, { backoff });
    await start(worker, job); await worker.idle();
    expect(job.status).toBe('complete');
    expect(job.chunks[0]).toMatchObject({ status: 'no_text', noTextReason: reason, review: { kind: 'missing_text' } });
    expect(job.chunks[0].attempts).toHaveLength(1);
    expect(job.chunks[0].attempts[0].outcome).toBe('success');
    expect(job.review).toMatchObject({ needsReview: true, missingTextCount: 1 });
    expect(job.text).toContain('FĂRĂ TRANSCRIERE');
    expect(job.text).toContain(job.filename);
    expect(job.text).toContain('00:00:00–00:01:00');
    const raw = JSON.parse(await readFile(join(store.jobDir(job.id), 'responses', 'chunk-000000.json'), 'utf8'));
    expect(raw).toEqual(response);
    expect(await readFile(join(store.jobDir(job.id), 'raw-transcript.txt'), 'utf8')).toBe('text' in response && typeof response.text === 'string' ? response.text : '');
    expect(await readFile(join(store.jobDir(job.id), 'transcript.txt'), 'utf8')).toBe(job.text);
    expect(job.audioAvailable).toBe(true);
    expect((await stat(job.sourceFile)).isFile()).toBe(true);
    expect((await stat(job.chunks[0].file)).isFile()).toBe(true);
    await worker.start(job.id); await worker.idle();
    const reopened = new Store(folder);
    const restarted = new Engine(reopened, { key: async () => fakeKey, transcriber: send, analyze: async () => quietAnalysis() });
    await restarted.start(job.id); await restarted.idle();
    expect(reopened.get(job.id).chunks[0].status).toBe('no_text');
    expect(send).toHaveBeenCalledOnce();
    expect(backoff).not.toHaveBeenCalled();
    expect(reopened.usage().requests).toBe(1);
  });

  it('places the no-text marker between surrounding model text while raw export preserves all returned characters', async () => {
    const job = await lecture([part(2), part(0), part(1)]);
    job.audio = { ...audio, duration: 180 };
    const responses = ['  Și, și... început.\n', '\t \n', '\nSfârșit, sfârșit.  '];
    const send = vi.fn<Transcriber>(async input => ({ text: responses[Number(/chunk-(\d+)\.wav$/.exec(input.file)![1])] }));
    const worker = engine(send);
    await start(worker, job); await worker.idle();
    expect(send).toHaveBeenCalledTimes(3);
    expect(job.text.indexOf(responses[0])).toBeLessThan(job.text.indexOf('FĂRĂ TRANSCRIERE'));
    expect(job.text.indexOf('FĂRĂ TRANSCRIERE')).toBeLessThan(job.text.indexOf(responses[2]));
    expect(job.text).toContain('00:01:00–00:02:00');
    expect(await readFile(join(store.jobDir(job.id), 'raw-transcript.txt'), 'utf8')).toBe(responses.join('\n\n'));
    expect(new Store(folder).get(job.id).text).toBe(job.text);
  });

  it('skips a terminal no-text section when another failed section is manually resumed', async () => {
    const job = await lecture([part(0), part(1)]);
    let fail = true;
    const calls: string[] = [];
    const worker = engine(async input => {
      calls.push(input.file);
      if (input.file.endsWith('chunk-000000.wav')) return { text: '' };
      if (fail) throw Object.assign(new Error('temporary outage'), { status: 503 });
      return { text: 'A doua secțiune.' };
    });
    await start(worker, job); await worker.idle();
    expect(job.status).toBe('failed');
    expect(job.chunks.map(chunk => chunk.status)).toEqual(['no_text', 'failed']);
    fail = false;
    await start(worker, job); await worker.idle();
    expect(calls.filter(file => file.endsWith('chunk-000000.wav'))).toHaveLength(1);
    expect(calls.filter(file => file.endsWith('chunk-000001.wav'))).toHaveLength(2);
    expect(job.status).toBe('complete');
    expect(job.text).toContain('FĂRĂ TRANSCRIERE');
    expect(job.text).toContain('A doua secțiune.');
  });

  it('flags sparse text over substantial detected speech without flagging an ordinary short final section', async () => {
    const first = part(0); first.end = 120;
    const last = part(1); last.start = 120; last.end = 130;
    const job = await lecture([first, last]); job.audio = { ...audio, duration: 130 }; job.appSettings.keepAudio = false;
    const speech: SpeechAnalysis = { ...quietAnalysis(130), intervals: [{ start: 0, end: 130 }], speechSeconds: 130 };
    const send = vi.fn<Transcriber>(async () => ({ text: 'Text scurt.' }));
    const worker = engine(send, { analyze: async () => speech });
    await start(worker, job); await worker.idle();
    expect(first.review).toMatchObject({ kind: 'short_text', basis: 'speech', speechSeconds: 120, wordCount: 2, wordsPerMinute: 1 });
    expect(last.review).toBeUndefined();
    expect(job.review?.shortTextCount).toBe(1);
    expect(job.text).toContain('Transcriere posibil incompletă');
    expect(job.audioAvailable).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('uses the visible duration fallback and retains audio when local analysis throws', async () => {
    const chunk = part(0); chunk.end = 180;
    const job = await lecture([chunk]); job.audio = { ...audio, duration: 180 }; job.appSettings.keepAudio = false;
    const analyze = vi.fn(async () => { throw new Error('private VAD path /private/audio sk-secret'); });
    const send = vi.fn<Transcriber>(async () => ({ text: 'Puține cuvinte.' }));
    const worker = engine(send, { analyze });
    await start(worker, job); await worker.idle();
    expect(job.status).toBe('complete');
    expect(job.speech).toMatchObject({ status: 'unavailable', intervals: [], speechSeconds: 0 });
    expect(JSON.stringify(job.speech)).not.toContain('/private/audio');
    expect(JSON.stringify(job.speech)).not.toContain('sk-secret');
    expect(chunk.review).toMatchObject({ kind: 'short_text', basis: 'duration', wordCount: 2 });
    expect(job.review).toMatchObject({ needsReview: true, analysisUnavailable: true });
    expect(job.text).toContain('VERIFICARE AUDIO INDISPONIBILĂ');
    expect(job.audioAvailable).toBe(true);
    expect(analyze).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
    await worker.cleanupAudio(job);
    expect((await stat(job.sourceFile)).isFile()).toBe(true);
  });

  it('persists an explicit unavailable analysis and never reruns it on resume', async () => {
    const job = await lecture([part(0)]);
    const analyze = vi.fn(async () => ({ ...quietAnalysis(), status: 'unavailable' as const, analyzedSeconds: 0, reason: 'Local model unavailable.' }));
    let fail = true;
    const send = vi.fn<Transcriber>(async () => { if (fail) throw Object.assign(new Error('rate limit'), { status: 429 }); return { text: 'Rezultat.' }; });
    const worker = engine(send, { analyze });
    await start(worker, job); await worker.idle();
    expect(job.chunks[0].status).toBe('failed');
    fail = false;
    await start(worker, job); await worker.idle();
    expect(analyze).toHaveBeenCalledOnce();
    expect(job.review?.analysisUnavailable).toBe(true);
    expect(job.audioAvailable).toBe(true);
  });

  it('cancels local analysis before any OpenAI request, then analyzes again when resumed', async () => {
    const job = await lecture([part(0)]);
    const entered = deferred<void>();
    let first = true;
    const analyze = vi.fn(async (_source: string, info: AudioInfo, signal?: AbortSignal): Promise<SpeechAnalysis> => {
      if (!first) return quietAnalysis(info.duration);
      first = false; entered.resolve();
      return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true }));
    });
    const send = vi.fn<Transcriber>(async () => ({ text: 'Text complet.' }));
    const worker = engine(send, { analyze });
    await start(worker, job); await entered.promise;
    expect(job.status).toBe('analyzing');
    worker.cancel(job.id); await worker.idle();
    expect(job.status).toBe('cancelled');
    expect(job.speech).toBeUndefined();
    expect(job.chunks[0].status).toBe('pending');
    expect(job.chunks[0].attempts).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
    expect(store.usage().requests).toBe(0);
    await start(worker, job); await worker.idle();
    expect(analyze).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledOnce();
    expect(job.status).toBe('complete');
  });

  it('recovers interruption during local analysis as paused with no billable request', async () => {
    const job = await lecture([part(0)]); job.status = 'analyzing'; store.save(job);
    const reopened = new Store(folder); const recovered = reopened.get(job.id);
    expect(recovered.status).toBe('paused');
    expect(recovered.speech).toBeUndefined();
    expect(recovered.chunks[0].status).toBe('pending');
    expect(reopened.usage()).toEqual({ requests: 0, uncertainRequests: 0, estimatedUsd: 0 });
    expect(recovered.text).toContain('NEPROCESAT');
    expect((await stat(recovered.sourceFile)).isFile()).toBe(true);
  });

  it.each([{ text: '' }, { text: ' \n' }, {}, { text: false }])('recovers durable successful response %j as terminal review work without another call', async response => {
    const job = await lecture([part(0)]); job.status = 'transcribing';
    job.chunks[0].attempts.push({ startedAt: new Date().toISOString(), outcome: 'pending', estimatedUsd: estimateCost(60) });
    store.save(job); store.saveResponse(job, job.chunks[0].id, response);
    const reopened = new Store(folder); const recovered = reopened.get(job.id);
    expect(recovered.status).toBe('complete');
    expect(recovered.chunks[0].status).toBe('no_text');
    expect(recovered.chunks[0].attempts[0].outcome).toBe('success');
    expect(recovered.review).toMatchObject({ needsReview: true, missingTextCount: 1, analysisNotRun: true });
    expect(recovered.text).toContain('FĂRĂ TRANSCRIERE');
    expect(reopened.usage()).toEqual({ requests: 1, uncertainRequests: 0, estimatedUsd: estimateCost(60) });
    const send = vi.fn<Transcriber>(async () => ({ text: 'Must not run' }));
    const worker = new Engine(reopened, { key: async () => fakeKey, transcriber: send, analyze: async () => quietAnalysis() });
    await worker.start(job.id); await worker.idle(); await worker.cleanupAudio(recovered);
    expect(send).not.toHaveBeenCalled();
    expect((await stat(recovered.sourceFile)).isFile()).toBe(true);
  });

  it.each(['', ' \n', undefined])('migrates legacy completed text %j into no_text without changing raw strings', async original => {
    const job = await lecture([part(0)]);
    job.status = 'complete'; job.chunks[0].status = 'complete'; job.chunks[0].text = original;
    // Write an old manifest directly: current save() already performs this migration.
    await writeFile(join(store.jobDir(job.id), 'manifest.json'), JSON.stringify(job));
    const reopened = new Store(folder); const migrated = reopened.get(job.id);
    expect(migrated.chunks[0].status).toBe('no_text');
    expect(migrated.chunks[0].text).toBe(original);
    expect(migrated.review?.missingTextCount).toBe(1);
    expect(await readFile(join(store.jobDir(job.id), 'raw-transcript.txt'), 'utf8')).toBe(original ?? '');
  });

  it.each(['pending', 'failed', 'interrupted', 'no_chunks'] as const)('keeps audio when a saved complete job actually contains %s work', async state => {
    const job = await lecture(state === 'no_chunks' ? [] : [part(0)]);
    job.status = 'complete'; job.appSettings.keepAudio = false; job.speech = quietAnalysis();
    if (job.chunks[0]) job.chunks[0].status = state as 'pending' | 'failed' | 'interrupted';
    store.save(job);
    const worker = engine(async () => ({ text: 'unused' }));
    await worker.cleanupAudio(job);
    expect((await stat(job.sourceFile)).isFile()).toBe(true);
    const reopened = new Store(folder); const recovered = reopened.get(job.id);
    expect(recovered.status).toBe('paused');
    expect(recovered.error).toContain('unfinished');
    expect(recovered.audioAvailable).toBe(true);
  });

  it.each([
    { start: -1, end: 10 }, { start: 10, end: 10 }, { start: 20, end: 10 },
    { start: null, end: 10 }, { start: 0, end: '60' },
  ])('rejects unsafe saved section timing %j before any cleanup', async times => {
    const job = await lecture([part(0)]);
    Object.assign(job.chunks[0], times);
    await writeFile(join(store.jobDir(job.id), 'manifest.json'), JSON.stringify(job));
    expect(() => new Store(folder)).toThrow('invalid or unsafe local file reference');
    expect((await stat(job.sourceFile)).isFile()).toBe(true);
  });
});
