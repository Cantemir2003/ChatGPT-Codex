/** Browser-test fixture: real HTTP, persistence and FFmpeg; no live OpenAI requests. */
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../server/store.js';
import { Engine } from '../server/engine.js';
import { createApp } from '../server/http.js';
import type { KeyStore } from '../server/keychain.js';
import { PRICING } from '../shared/config.js';

const directory = process.env.LECTURE_UI_TEST_DIR;
if (!directory) throw new Error('This test server requires LECTURE_UI_TEST_DIR.');
await mkdir(directory, { recursive: true });
const recording = join(directory, 'mock-romanian-lecture.m4a');
const generated = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '3', '-c:a', 'aac', '-y', recording], { encoding: 'utf8' });
if (generated.status !== 0) throw new Error('The browser test requires FFmpeg to create its synthetic audio.');

// Deliberately mock the platform keychain, never the browser or production API routes.
class MemoryKeyStore implements KeyStore {
  private value: string | null = null;
  async get() { return this.value; }
  async set(value: string) { this.value = value; }
  async remove() { this.value = null; }
  async status() { return { configured: this.value !== null, storage: 'macos-keychain' as const }; }
}
const keyStore = new MemoryKeyStore();
const store = new Store(join(directory, 'data'));
const expectedText = 'Bună ziua. Astăzi discutăm despre sănătatea orală și țesuturile dentare.\n\nȘtiință, înțelegere și îngrijire. Repetăm: îngrijire, îngrijire.\nAcesta este un răspuns simulat pentru verificarea aplicației.';
const engine = new Engine(store, {
  key: () => keyStore.get(),
  transcriber: async ({ signal, onPhase, onDelta }) => {
    onPhase('transcribing');
    onDelta('Bună ziua. Astăzi discutăm despre sănătatea orală');
    await delay(650, undefined, { signal });
    return { text: expectedText, testFixture: true };
  },
});

const server = createServer();
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await engine.stop();
  server.close(() => process.exit(0));
  server.closeAllConnections();
}
server.on('request', createApp({
  port: 0,
  dataDir: store.dataDir,
  uploadDir: join(store.dataDir, 'uploads'),
  clientDir: resolve('dist/client'),
  keyStore,
  bootstrap: () => ({ ffmpegAvailable: true, preferences: store.preferences, jobs: store.list(), pricing: PRICING, usage: store.usage() }),
  listJobs: () => store.list(),
  getJob: id => store.jobs.get(id),
  importAudio: (path, name) => engine.importAudio(path, name),
  startJob: (id, settings, appSettings) => engine.start(id, settings, appSettings),
  cancelJob: id => engine.cancel(id),
  deleteJob: id => engine.remove(id),
  savePreferences: preferences => store.savePreferences(preferences),
  shutdown,
}));
await new Promise<void>((resolveReady, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolveReady);
});
const address = server.address();
if (!address || typeof address === 'string') throw new Error('The UI test server could not start.');
process.stdout.write(JSON.stringify({ url: `http://127.0.0.1:${address.port}`, recording, expectedText }) + '\n');
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
