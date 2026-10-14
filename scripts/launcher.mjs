import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const url = 'http://127.0.0.1:43187';
const dataDir = join(homedir(), 'Library', 'Application Support', 'Lecture Transcriber');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const request = (path, options = {}) => fetch(`${url}${path}`, {
  ...options, signal: AbortSignal.timeout(2000),
});
async function isRunning() {
  try {
    const response = await request('/api/health');
    return response.ok && (await response.json()).app === 'lecture-transcriber';
  } catch { return false; }
}
function openBrowser() {
  const child = spawn('/usr/bin/open', [url], { stdio: 'ignore', detached: true });
  child.on('error', () => console.log(`Open this address in your browser: ${url}`));
  child.unref();
}
async function start() {
  if (await isRunning()) {
    console.log('Lecture Transcriber is already running. Opening your browser.');
    openBrowser();
    return;
  }
  if (!existsSync(join(root, 'dist', 'server', 'index.js')) || !existsSync(join(root, 'bin', 'keychain-helper'))) {
    throw new Error('First double-click First-time Setup.command in this folder.');
  }
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const logPath = join(dataDir, 'launcher.log');
  const log = openSync(logPath, 'a', 0o600);
  let launchError;
  const child = spawn(process.execPath, [join(root, 'dist', 'server', 'index.js')], {
    cwd: root, env: { ...process.env, NODE_ENV: 'production' },
    detached: true, stdio: ['ignore', log, log],
  });
  closeSync(log);
  child.on('error', error => { launchError = error; });
  child.unref();
  // The server's exclusive loopback port resolves two simultaneous launches.
  // Only the process that owns that port runs jobs; both launchers open it.
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await isRunning()) {
      console.log('Lecture Transcriber is running. You can close this Terminal window.');
      console.log('To stop it, double-click Stop Lecture Transcriber.command.');
      openBrowser();
      return;
    }
    if (launchError) break;
    await delay(250);
  }
  throw new Error(`Could not start Lecture Transcriber. Run First-time Setup.command again. If the problem continues, check ${logPath}. Another app may be using port 43187.`);
}
async function stop() {
  if (!await isRunning()) {
    console.log('Lecture Transcriber is not running.');
    return;
  }
  const bootstrapResponse = await request('/api/bootstrap');
  if (!bootstrapResponse.ok) throw new Error('Could not contact the app. Try stopping it again.');
  const { csrfToken } = await bootstrapResponse.json();
  if (typeof csrfToken !== 'string' || !csrfToken) throw new Error('The app did not provide its shutdown token.');
  const response = await request('/api/shutdown', {
    method: 'POST',
    headers: { 'X-CSRF-Token': csrfToken, Origin: url, 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!response.ok) throw new Error('The app could not stop cleanly. Try again from its browser window.');
  for (let attempt = 0; attempt < 60; attempt++) {
    if (!await isRunning()) {
      console.log('Lecture Transcriber has stopped. Completed sections are saved.');
      return;
    }
    await delay(250);
  }
  throw new Error('Shutdown is taking longer than expected. Wait a moment and try Stop again.');
}

try {
  if (process.platform !== 'darwin') throw new Error('These double-click launchers are for macOS. See docs/DEVELOPMENT.md for development commands.');
  if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Install Node.js 24 LTS from nodejs.org, then run First-time Setup.command.');
  if (process.argv[2] === 'start') await start();
  else if (process.argv[2] === 'stop') await stop();
  else throw new Error('Expected start or stop.');
} catch (error) {
  console.error(`\n${error.message}\n`);
  process.exitCode = 1;
}
