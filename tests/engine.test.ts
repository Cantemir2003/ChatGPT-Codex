import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../server/engine.js';
import { Store } from '../server/store.js';
import { DEFAULTS, estimateCost } from '../shared/config.js';
import type { AudioInfo, Chunk, Job } from '../shared/types.js';
import type { Transcriber, TranscribeResult } from '../server/transcribe.js';

let folder: string;
let store: Store;
const fakeKey = 'sk-test-never-sent-to-a-network';
const audio: AudioInfo = { duration: 120, size: 5, codec: 'aac', sampleRate: 48000, channels: 1, format: 'mov,mp4,m4a' };

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
  return new Engine(store, { key: async () => fakeKey, transcriber, backoff: async () => {}, ...overrides });
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
    expect(job.text).toBe('Prima secțiune.');
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
    expect(recovered.text).toBe('Știință. Știință.');
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
    expect(recovered.chunks[1].status).toBe('pending');
    expect(recovered.text).toBe('Completed text.');
    expect(await readFile(join(reopened.jobDir(job.id), 'transcript.txt'), 'utf8')).toBe('Completed text.');
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
    expect(job.text).toBe('Păstrat exact.');
    expect(job.chunks[0].status).toBe('complete');
    expect(job.chunks[1].status).toBe('pending');
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
    expect(job.text).toBe('');
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
