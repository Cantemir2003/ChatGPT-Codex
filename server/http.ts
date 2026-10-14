import express, { type ErrorRequestHandler, type Request } from 'express';
import multer from 'multer';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { chmod, realpath, rm } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import type { AppSettings, Bootstrap, Job, Preferences, TranscriptionSettings } from '../shared/types.js';
import { type KeyStore, isValidKey } from './keychain.js';
import { AppError, validateApp, validatePreferences, validateTranscription } from './validation.js';

type MaybePromise<T> = T | Promise<T>;
export interface HttpDependencies {
  port: number;
  dataDir: string;
  uploadDir: string;
  clientDir?: string;
  keyStore: KeyStore;
  bootstrap(): MaybePromise<Omit<Bootstrap, 'csrfToken' | 'keyConfigured' | 'keyStorage' | 'dataDir'>>;
  listJobs(): MaybePromise<Job[]>;
  getJob(id: string): MaybePromise<Job | undefined>;
  importAudio(path: string, filename: string): Promise<Job>;
  startJob(id: string, settings: TranscriptionSettings, appSettings: AppSettings): MaybePromise<Job>;
  cancelJob(id: string): MaybePromise<Job>;
  deleteJob(id: string): MaybePromise<void>;
  savePreferences(preferences: Preferences): MaybePromise<Preferences>;
  beforeKeyChange?(): MaybePromise<void>;
  shutdown(): MaybePromise<void>;
}

/** Filesystem paths never need to leave the backend to identify a job or chunk. */
export function publicJob(job: Job): Job {
  return {
    ...job,
    sourceFile: '',
    chunks: job.chunks.map(chunk => ({ ...chunk, file: '' })),
  };
}

const safeFilename = (name: string) => basename(name.replace(/\\/g, '/')).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 240) || 'audio';
const csrfMatches = (actual: string | undefined, expected: string) => {
  if (!actual || actual.length !== expected.length) return false;
  const candidate = Buffer.from(actual);
  const token = Buffer.from(expected);
  return candidate.length === token.length && timingSafeEqual(candidate, token);
};
const inside = (root: string, candidate: string) => {
  const path = relative(root, candidate);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};

export function createApp(deps: HttpDependencies) {
  const app = express();
  const csrfToken = randomBytes(32).toString('hex');
  mkdirSync(deps.uploadDir, { recursive: true, mode: 0o700 });
  chmodSync(deps.uploadDir, 0o700);
  const upload = multer({
    // Browser FormData sends UTF-8 filename bytes without a charset parameter.
    // Decode once in the multipart parser; explicit filename* charsets still win.
    defParamCharset: 'utf8',
    storage: multer.diskStorage({
      destination: deps.uploadDir,
      filename: (_req, _file, callback) => callback(null, randomBytes(24).toString('hex')),
    }),
    limits: { fileSize: 8 * 1024 ** 3, files: 1, fields: 0, parts: 1, fieldNameSize: 40, headerPairs: 50 },
  });
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cache-Control': 'no-store',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
    const port = deps.port === 0 ? req.socket.localPort : deps.port;
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    const host = req.get('host');
    if (!host || !hosts.includes(host)) { res.status(403).json({ error: 'This app only accepts local requests.' }); return; }
    const origin = req.get('origin');
    if (origin && origin !== `http://${host}`) { res.status(403).json({ error: 'This app only accepts same-origin requests.' }); return; }
    const fetchSite = req.get('sec-fetch-site');
    if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
      res.status(403).json({ error: 'This app only accepts same-origin requests.' }); return;
    }
    if (req.path.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !csrfMatches(req.get('x-csrf-token'), csrfToken)) {
      res.status(403).json({ error: 'The session token is missing or expired. Reload the app.' }); return;
    }
    next();
  });
  app.use(express.json({ limit: '1mb', strict: true }));

  const findJob = async (req: Request) => {
    const id = req.params.id;
    if (typeof id !== 'string') throw new AppError('Recording not found.', 404);
    const job = await deps.getJob(id);
    if (!job) throw new AppError('Recording not found.', 404);
    return job;
  };
  app.get('/api/health', (_req, res) => { res.json({ app: 'lecture-transcriber' }); });
  app.get('/api/bootstrap', async (_req, res) => {
    const [bootstrap, status] = await Promise.all([deps.bootstrap(), deps.keyStore.status()]);
    res.json({ ...bootstrap, jobs: bootstrap.jobs.map(publicJob), csrfToken, keyConfigured: status.configured, keyStorage: status.storage, dataDir: deps.dataDir } satisfies Bootstrap);
  });
  app.get('/api/jobs', async (_req, res) => { res.json((await deps.listJobs()).map(publicJob)); });
  app.get('/api/jobs/:id', async (req, res) => { res.json(publicJob(await findJob(req))); });
  app.post('/api/jobs', upload.single('file'), async (req, res) => {
    const file = req.file;
    if (!file) throw new AppError('Choose an audio recording to import.', 400);
    let job: Job;
    try {
      await chmod(file.path, 0o600);
      job = await deps.importAudio(file.path, safeFilename(file.originalname));
    } finally {
      // importAudio owns a separate durable copy. Failed or cancelled uploads leave no residue.
      await rm(file.path, { force: true }).catch(() => {});
    }
    res.status(201).json(publicJob(job));
  });
  app.post('/api/jobs/:id/start', async (req, res) => {
    const job = await findJob(req);
    const settings = validateTranscription(req.body?.settings);
    const appSettings = validateApp(req.body?.appSettings);
    res.json(publicJob(await deps.startJob(job.id, settings, appSettings)));
  });
  app.post('/api/jobs/:id/cancel', async (req, res) => {
    const job = await findJob(req);
    res.json(publicJob(await deps.cancelJob(job.id)));
  });
  app.delete('/api/jobs/:id', async (req, res) => {
    const job = await findJob(req);
    await deps.deleteJob(job.id);
    res.status(204).end();
  });
  app.get('/api/jobs/:id/audio', async (req, res, next) => {
    const job = await findJob(req);
    if (!job.audioAvailable || !job.sourceFile) throw new AppError('The local audio is no longer available.', 404);
    const [root, source] = await Promise.all([realpath(deps.dataDir), realpath(job.sourceFile).catch(() => '')]);
    if (!source || !inside(root, source)) throw new AppError('The local audio is no longer available.', 404);
    res.set('Content-Disposition', 'inline');
    res.sendFile(source, { acceptRanges: true, cacheControl: false, dotfiles: 'deny' }, error => {
      if (!error) return;
      if (res.headersSent) { res.destroy(); return; }
      next(new AppError('The local audio could not be opened.', 404));
    });
  });
  app.get('/api/jobs/:id/export', async (req, res) => {
    const job = await findJob(req);
    const filename = safeFilename(job.filename).replace(/\.[^.]*$/, '') + '.txt';
    res.attachment(filename).type('text/plain; charset=utf-8').send(job.text);
  });
  app.put('/api/preferences', async (req, res) => { res.json(await deps.savePreferences(validatePreferences(req.body))); });
  app.post('/api/key', async (req, res) => {
    if (!isValidKey(req.body?.key)) throw new AppError('Enter a valid OpenAI API key beginning with sk-.', 400);
    await deps.beforeKeyChange?.();
    try { await deps.keyStore.set(req.body.key); }
    catch { throw new AppError('The API key could not be saved to macOS Keychain. Check that Keychain is unlocked and try again.', 503); }
    res.json({ configured: true, storage: 'macos-keychain' });
  });
  app.delete('/api/key', async (_req, res) => {
    await deps.beforeKeyChange?.();
    try { await deps.keyStore.remove(); }
    catch { throw new AppError('The API key could not be removed from macOS Keychain. Check that Keychain is unlocked and try again.', 503); }
    res.json({ configured: false, storage: 'macos-keychain' });
  });
  app.post('/api/shutdown', (_req, res) => {
    res.json({ stopping: true });
    setImmediate(() => { Promise.resolve().then(() => deps.shutdown()).catch(() => {}); });
  });
  app.use('/api', (_req, res) => { res.status(404).json({ error: 'Endpoint not found.' }); });
  if (deps.clientDir) {
    const clientDir = resolve(deps.clientDir);
    app.use(express.static(clientDir, { dotfiles: 'deny', index: 'index.html', etag: false, maxAge: 0 }));
    app.get('/', (_req, res, next) => { res.sendFile(resolve(clientDir, 'index.html'), error => { if (error) next(error); }); });
  }
  app.use((_req, res) => { res.status(404).type('text/plain').send('Not found.'); });
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    if (res.headersSent) { res.destroy(); return; }
    if (error instanceof AppError) { res.status(error.statusCode).json({ error: error.message }); return; }
    if (error instanceof multer.MulterError) {
      res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'This recording exceeds the 8 GB local import limit.' : 'Choose one audio file and try again.' }); return;
    }
    if (error?.type === 'entity.too.large') { res.status(413).json({ error: 'The request is too large.' }); return; }
    if (error instanceof SyntaxError && 'body' in error) { res.status(400).json({ error: 'The request contains invalid JSON.' }); return; }
    res.status(500).json({ error: 'The request could not be completed. Try again or restart the app.' });
  };
  app.use(errors);
  return app;
}
