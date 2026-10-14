import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, request, type Server } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type HttpDependencies } from '../server/http.js';
import { isValidKey, MacOSKeyStore, type KeyStore } from '../server/keychain.js';
import { DEFAULTS, PRICING } from '../shared/config.js';
import type { Job } from '../shared/types.js';
import { Store } from '../server/store.js';

class MemoryKeyStore implements KeyStore {
  key: string | null = null;
  async get() { return this.key; }
  async set(key: string) { this.key = key; }
  async remove() { this.key = null; }
  async status() { return { configured: this.key !== null, storage: 'macos-keychain' as const }; }
}

let server: Server;
let folder: string;
let base: string;
let token: string;
let job: Job;
let deps: HttpDependencies;
let keyStore: MemoryKeyStore;
const key = 'sk-test_abcdefghijklmnopqrstuvwxyz0123456789';
const headers = () => ({ 'content-type': 'application/json', 'x-csrf-token': token });

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'lecture-security-'));
  await mkdir(join(folder, 'audio'));
  const sourceFile = join(folder, 'audio', 'private.m4a');
  await writeFile(sourceFile, '0123456789');
  keyStore = new MemoryKeyStore();
  const now = new Date().toISOString();
  job = {
    id: 'recording', filename: 'Curs științific.m4a', createdAt: now, updatedAt: now,
    status: 'ready', audio: { duration: 10, size: 10, codec: 'aac', sampleRate: 16000, channels: 1, format: 'm4a' },
    settings: structuredClone(DEFAULTS.transcription), appSettings: structuredClone(DEFAULTS.app),
    chunks: [{ id: 'part', index: 0, start: 0, end: 10, file: join(folder, 'chunk.m4a'), status: 'complete', text: 'Bună ziua.', attempts: [] }],
    text: 'Bună ziua. Știință și sănătate.\n', partialText: '', sourceFile, audioAvailable: true, estimatedUsd: 0,
  };
  deps = {
    port: 0, dataDir: folder, uploadDir: join(folder, 'uploads'), keyStore,
    bootstrap: () => ({ ffmpegAvailable: true, preferences: structuredClone(DEFAULTS), jobs: [job], pricing: PRICING, usage: { estimatedUsd: 0, uncertainRequests: 0, requests: 0 } }),
    listJobs: () => [job], getJob: id => id === job.id ? job : undefined,
    importAudio: vi.fn(async () => job),
    startJob: vi.fn(async () => job), cancelJob: vi.fn(async () => job),
    deleteJob: vi.fn(async () => {}), savePreferences: async preferences => preferences,
    shutdown: vi.fn(),
  };
  server = createServer(createApp(deps));
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test address');
  base = `http://127.0.0.1:${address.port}`;
  const bootstrap = await fetch(`${base}/api/bootstrap`).then(r => r.json());
  token = bootstrap.csrfToken;
});

afterEach(async () => {
  await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  await rm(folder, { recursive: true, force: true });
});

describe('local HTTP security', () => {
  it('allows launcher health checks and sends browser hardening headers without CORS', async () => {
    const response = await fetch(`${base}/api/health`);
    expect(await response.json()).toEqual({ app: 'lecture-transcriber' });
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('rejects DNS rebinding hostnames before any API read', async () => {
    // fetch protects Host itself; use the raw HTTP client to exercise a rebinding request.
    const response = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
      const pending = request(`${base}/api/bootstrap`, { headers: { host: 'attacker.example:43187' } }, incoming => {
        let body = '';
        incoming.setEncoding('utf8');
        incoming.on('data', chunk => { body += chunk; });
        incoming.on('end', () => resolve({ status: incoming.statusCode, body }));
      });
      pending.on('error', reject);
      pending.end();
    });
    expect(response.status).toBe(403);
    expect(response.body).not.toContain(token);
  });

  it.each([
    { origin: 'https://attacker.example' },
    { origin: 'null' },
    { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'same-site' },
  ])('rejects foreign reads: %s', async extra => {
    const response = await fetch(`${base}/api/bootstrap`, { headers: extra });
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain(token);
  });

  it.each([undefined, 'invalid', 'é'.repeat(64)])('rejects missing or invalid CSRF tokens', async candidate => {
    const response = await fetch(`${base}/api/key`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(candidate ? { 'x-csrf-token': candidate } : {}) }, body: JSON.stringify({ key }),
    });
    expect(response.status).toBe(403);
    expect(keyStore.key).toBeNull();
  });

  it('never returns a stored key and strips source/chunk paths', async () => {
    const response = await fetch(`${base}/api/key`, { method: 'POST', headers: headers(), body: JSON.stringify({ key }) });
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain(key);
    const bootstrap = await fetch(`${base}/api/bootstrap`).then(r => r.json());
    expect(bootstrap.keyConfigured).toBe(true);
    expect(JSON.stringify(bootstrap)).not.toContain(key);
    expect(bootstrap.jobs[0].sourceFile).toBe('');
    expect(bootstrap.jobs[0].chunks[0].file).toBe('');
    const jobs = await fetch(`${base}/api/jobs`).then(r => r.text());
    expect(jobs).not.toContain(folder);
  });

  it('does not echo invalid keys or Keychain error details', async () => {
    expect(isValidKey(`${key}\n`)).toBe(false);
    expect(isValidKey(`${key}\r\n`)).toBe(false);
    const invalid = 'not-an-api-key-secret';
    const rejected = await fetch(`${base}/api/key`, { method: 'POST', headers: headers(), body: JSON.stringify({ key: invalid }) });
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).not.toContain(invalid);
    keyStore.set = async () => { throw new Error(`sensitive ${key} ${folder}`); };
    const failed = await fetch(`${base}/api/key`, { method: 'POST', headers: headers(), body: JSON.stringify({ key }) });
    expect(failed.status).toBe(503);
    const body = await failed.text();
    expect(body).not.toContain(key);
    expect(body).not.toContain(folder);
  });

  it('sanitizes unexpected internal error details', async () => {
    deps.listJobs = () => { throw new Error(`secret ${key} at ${folder}`); };
    const response = await fetch(`${base}/api/jobs`);
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).not.toContain(key);
    expect(body).not.toContain(folder);
  });

  it('rejects malformed JSON without reflecting its content', async () => {
    const response = await fetch(`${base}/api/key`, { method: 'POST', headers: headers(), body: `{"key":"${key}"` });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(key);
  });

  it('imports privately, removes staging files, and never starts transcription automatically', async () => {
    let uploaded = '';
    deps.importAudio = vi.fn(async (path, filename) => {
      uploaded = path;
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(await readFile(path, 'utf8')).toBe('sample audio');
      expect(filename).toBe('lecture.m4a');
      return job;
    });
    const form = new FormData();
    form.append('file', new Blob(['sample audio'], { type: 'audio/mp4' }), 'lecture.m4a');
    const response = await fetch(`${base}/api/jobs`, { method: 'POST', headers: { 'x-csrf-token': token }, body: form });
    expect(response.status).toBe(201);
    expect(deps.importAudio).toHaveBeenCalledOnce();
    expect(deps.startJob).not.toHaveBeenCalled();
    expect(uploaded).toBeTruthy();
    expect(await readdir(deps.uploadDir)).toEqual([]);
  });

  it('rejects upload before writing when the session token is missing', async () => {
    const form = new FormData();
    form.append('file', new Blob(['private audio']), 'lecture.m4a');
    const response = await fetch(`${base}/api/jobs`, { method: 'POST', body: form });
    expect(response.status).toBe(403);
    expect(deps.importAudio).not.toHaveBeenCalled();
    expect(await readdir(deps.uploadDir)).toEqual([]);
  });

  it('preserves Romanian UTF-8 filenames through browser multipart upload and TXT download', async () => {
    const filename = 'Curs de medicină – Știință.m4a';
    deps.importAudio = vi.fn(async (_path, importedName) => {
      job.filename = importedName;
      return job;
    });
    const form = new FormData();
    form.append('file', new File(['audio'], filename, { type: 'audio/mp4' }));
    const response = await fetch(`${base}/api/jobs`, { method: 'POST', headers: { 'x-csrf-token': token }, body: form });
    expect(response.status).toBe(201);
    expect(deps.importAudio).toHaveBeenCalledWith(expect.any(String), filename);
    expect((await response.json()).filename).toBe(filename);

    const exported = await fetch(`${base}/api/jobs/recording/export`);
    expect(exported.status).toBe(200);
    const disposition = exported.headers.get('content-disposition') ?? '';
    const encodedName = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
    expect(encodedName).toBeDefined();
    expect(decodeURIComponent(encodedName!)).toBe('Curs de medicină – Știință.txt');
  });

  it('supports byte range playback and blocks files outside the private data directory', async () => {
    const response = await fetch(`${base}/api/jobs/recording/audio`, { headers: { range: 'bytes=2-5' } });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(await response.text()).toBe('2345');
    job.sourceFile = '/etc/hostname';
    const blocked = await fetch(`${base}/api/jobs/recording/audio`);
    expect(blocked.status).toBe(404);
  });

  it('exports only exact UTF-8 transcript text with no generated section headings', async () => {
    const response = await fetch(`${base}/api/jobs/recording/export`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('charset=utf-8');
    expect(response.headers.get('content-disposition')).toContain('attachment;');
    expect(await response.text()).toBe(job.text);
  });

  it('validates requested settings before calling the engine', async () => {
    const response = await fetch(`${base}/api/jobs/recording/start`, {
      method: 'POST', headers: headers(), body: JSON.stringify({ settings: { ...DEFAULTS.transcription, languages: ['invalid'] }, appSettings: DEFAULTS.app }),
    });
    expect(response.status).toBe(400);
    expect(deps.startJob).not.toHaveBeenCalled();
  });

  it('has no insecure non-macOS persistence fallback', async () => {
    if (process.platform === 'darwin') return;
    const native = new MacOSKeyStore('/missing/keychain-helper');
    expect(await native.status()).toEqual({ configured: false, storage: 'unavailable' });
    await expect(native.set(key)).rejects.toThrow('macOS Keychain is unavailable.');
  });
});

async function storedLecture() {
  const dataDir = join(folder, 'store');
  const store = new Store(dataDir);
  const id = randomUUID();
  const directory = store.jobDir(id);
  await mkdir(join(directory, 'audio'), { recursive: true });
  await mkdir(join(directory, 'responses'));
  const saved: Job = {
    ...structuredClone(job), id, sourceFile: join(directory, 'source.m4a'), status: 'complete',
    chunks: [{ ...structuredClone(job.chunks[0]), id: 'chunk-000000', file: join(directory, 'audio', 'chunk-000000.wav') }],
  };
  await writeFile(saved.sourceFile, 'original');
  await writeFile(saved.chunks[0].file, 'section');
  store.save(saved);
  const manifest = join(directory, 'manifest.json');
  const persist = () => writeFile(manifest, JSON.stringify(saved));
  return { dataDir, store, saved, directory, manifest, persist };
}

describe('saved lecture file ownership', () => {
  it('rejects a foreign source before recovery could trigger automatic audio cleanup', async () => {
    const { dataDir, saved, persist } = await storedLecture();
    const victim = join(folder, 'unrelated-recording.m4a');
    await writeFile(victim, 'keep this recording');
    saved.sourceFile = victim;
    await persist();
    expect(() => new Store(dataDir)).toThrow('unsafe local file reference');
    expect(await readFile(victim, 'utf8')).toBe('keep this recording');
  });

  it('rejects a chunk outside its own lecture audio directory', async () => {
    const { dataDir, saved, persist } = await storedLecture();
    saved.chunks[0].file = join(folder, 'elsewhere.wav');
    await persist();
    expect(() => new Store(dataDir)).toThrow('unsafe local file reference');
  });

  it('rejects path traversal in chunk IDs before reading response files', async () => {
    const { dataDir, saved, persist } = await storedLecture();
    saved.chunks[0].id = '../../../private';
    saved.chunks[0].status = 'pending';
    await persist();
    expect(() => new Store(dataDir)).toThrow('unsafe local file reference');
  });

  it.each(['id', 'index'] as const)('rejects duplicate chunk %s values', async field => {
    const { dataDir, saved, directory, persist } = await storedLecture();
    const duplicate = { ...structuredClone(saved.chunks[0]), id: 'chunk-000001', index: 1, file: join(directory, 'audio', 'chunk-000001.wav') };
    if (field === 'id') { duplicate.id = saved.chunks[0].id; duplicate.file = saved.chunks[0].file; }
    else duplicate.index = saved.chunks[0].index;
    saved.chunks.push(duplicate);
    await persist();
    expect(() => new Store(dataDir)).toThrow('unsafe local file reference');
  });

  it('rejects a symlink source even when its manifest path looks owned', async () => {
    const { dataDir, saved } = await storedLecture();
    const outside = join(folder, 'outside.m4a');
    await writeFile(outside, 'external');
    await rm(saved.sourceFile);
    await symlink(outside, saved.sourceFile);
    expect(() => new Store(dataDir)).toThrow('unsafe local file reference');
    expect(await readFile(outside, 'utf8')).toBe('external');
  });

  it('rejects a symlink audio directory before any chunk can be uploaded', async () => {
    const { dataDir, directory } = await storedLecture();
    const outside = join(folder, 'outside-audio');
    await mkdir(outside);
    await rm(join(directory, 'audio'), { recursive: true });
    await symlink(outside, join(directory, 'audio'));
    expect(() => new Store(dataDir)).toThrow('unsafe local file reference');
  });

  it('rejects a symlink response file before crash recovery reads it', async () => {
    const { dataDir, directory, saved, persist } = await storedLecture();
    saved.chunks[0].status = 'pending';
    await persist();
    const outside = join(folder, 'external-response.json');
    await writeFile(outside, JSON.stringify({ text: 'foreign data' }));
    await symlink(outside, join(directory, 'responses', 'chunk-000000.json'));
    expect(() => new Store(dataDir)).toThrow('unsafe local file reference');
  });

  it('rejects a symlink manifest without following it', async () => {
    const { dataDir, manifest } = await storedLecture();
    const outside = join(folder, 'external-manifest.json');
    await writeFile(outside, await readFile(manifest));
    await rm(manifest);
    await symlink(outside, manifest);
    expect(() => new Store(dataDir)).toThrow('unsafe local file reference');
  });

  it('allows a completed lecture whose owned audio was already cleaned up', async () => {
    const { dataDir, directory, saved, persist } = await storedLecture();
    saved.audioAvailable = false;
    await rm(saved.sourceFile);
    await rm(join(directory, 'audio'), { recursive: true });
    await persist();
    const recovered = new Store(dataDir).get(saved.id);
    expect(recovered.status).toBe('complete');
    expect(recovered.audioAvailable).toBe(false);
    expect(recovered.text).toBe(saved.chunks[0].text);
  });

  it('rechecks file ownership before saving a response or deleting a lecture', async () => {
    const { store, saved } = await storedLecture();
    saved.sourceFile = join(folder, 'outside.m4a');
    expect(() => store.saveResponse(saved, 'chunk-000000', { text: 'response' })).toThrow('unsafe local file reference');
    expect(() => store.remove(saved.id)).toThrow('unsafe local file reference');
  });
});
