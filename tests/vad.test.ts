import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { inspectAudio } from '../server/audio.js';
import { analyzeSpeech, SpeechIntervals, VAD_MODEL_SHA256, VAD_VERSION } from '../server/vad.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = path.join(root, 'models/speech-fixture.wav');
let directory: string;

async function command(binary: string, args: string[], cwd?: string) {
  const child = spawn(binary, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', data => { if (stdout.length < 8192) stdout += data; });
  child.stderr.on('data', data => { if (stderr.length < 8192) stderr += data; });
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`${binary} failed: ${stderr}`)));
  });
  return { stdout, stderr };
}
async function generated(name: string, filter: string): Promise<string> {
  const file = path.join(directory, name);
  await command('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', filter, '-c:a', 'pcm_s16le', file]);
  return file;
}
beforeAll(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-vad-test-')); });
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await fs.rm(directory, { recursive: true, force: true }); });

describe('Silero speech interval assembly', () => {
  it('finishes speech at the actual last sample, not the padded inference window', () => {
    const detector = new SpeechIntervals();
    for (let sample = 0; sample < 8_013; sample += 512) detector.accept(0.9, sample);
    expect(detector.finish(8_013)).toEqual([{ start: 0, end: 8_013 / 16000 }]);
  });
  it('uses hysteresis, ignores brief blips, and maintains separate padded intervals', () => {
    const detector = new SpeechIntervals();
    for (let sample = 0; sample < 40_000; sample += 512) {
      const probability = sample < 1024 || (sample >= 8000 && sample < 16_000) || sample >= 32_000 ? 0.9 : 0.05;
      detector.accept(probability, sample);
    }
    const intervals = detector.finish(40_000);
    expect(intervals).toHaveLength(2);
    expect(intervals[0].start).toBeGreaterThan(0.4);
    expect(intervals[0].end).toBeLessThan(intervals[1].start);
    expect(intervals[1].end).toBe(2.5);
    expect(() => detector.accept(NaN, 0)).toThrow('invalid result');
  });
});

describe('bundled local Silero inference', () => {
  it('verifies the exact pinned model and detects real speech', async () => {
    const bytes = await fs.readFile(path.join(root, `models/silero_vad_v${VAD_VERSION}.onnx`));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(VAD_MODEL_SHA256);
    const audio = await inspectAudio(fixture);
    const result = await analyzeSpeech(fixture, audio);
    expect(result.status).toBe('complete');
    expect(result.model).toBe('silero-vad');
    expect(result.version).toBe('6.2.3');
    expect(result.analyzedSeconds).toBe(8);
    expect(result.speechSeconds).toBeGreaterThan(5);
    expect(result.speechSeconds).toBeLessThan(8);
    expect(result.intervals.length).toBeGreaterThan(1);
    for (const [index, interval] of result.intervals.entries()) {
      expect(interval.start).toBeGreaterThanOrEqual(index ? result.intervals[index - 1].end : 0);
      expect(interval.end).toBeGreaterThan(interval.start);
      expect(interval.end).toBeLessThanOrEqual(8);
    }
  });

  it('does not classify digital silence or a steady tone as speech', async () => {
    for (const [name, filter] of [
      ['silence.wav', 'anullsrc=r=16000:cl=mono:d=3.013'],
      ['tone.wav', 'sine=frequency=440:sample_rate=16000:duration=3.013'],
    ]) {
      const file = await generated(name, filter);
      const result = await analyzeSpeech(file, await inspectAudio(file));
      expect(result.status).toBe('complete');
      expect(result.analyzedSeconds).toBeCloseTo(3.013, 4);
      expect(result.intervals).toEqual([]);
      expect(result.speechSeconds).toBe(0);
    }
  });

  it('analyzes stereo 48-kHz audio in original time without modifying its source', async () => {
    const file = path.join(directory, 'stereo.wav');
    await command('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-i', fixture,
      '-af', 'adelay=1200:all=1', '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s24le', file]);
    const before = createHash('sha256').update(await fs.readFile(file)).digest('hex');
    const audio = await inspectAudio(file);
    expect(audio.channels).toBe(2); expect(audio.sampleRate).toBe(48_000);
    const result = await analyzeSpeech(file, audio);
    expect(result.status).toBe('complete');
    expect(result.intervals[0].start).toBeGreaterThan(1.1);
    expect(result.intervals[0].start).toBeLessThan(1.5);
    expect(result.speechSeconds).toBeGreaterThan(5);
    expect(result.analyzedSeconds).toBeCloseTo(9.2, 5);
    expect(createHash('sha256').update(await fs.readFile(file)).digest('hex')).toBe(before);
    expect((await inspectAudio(file)).channels).toBe(2);
  });

  it('clamps real detected speech at a non-frame-aligned recording end', async () => {
    const file = path.join(directory, 'speech-tail.wav');
    await command('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-i', fixture,
      '-t', '6.501', '-c:a', 'pcm_s16le', file]);
    const audio = await inspectAudio(file);
    const result = await analyzeSpeech(file, audio);
    expect(result.status).toBe('complete');
    expect(result.intervals.at(-1)!.end).toBe(audio.duration);
    expect(result.analyzedSeconds).toBe(audio.duration);
  });

  it('streams a longer recording and counts its exact final partial frame', async () => {
    const file = await generated('long-silence.wav', 'anullsrc=r=8000:cl=mono:d=120.013');
    const result = await analyzeSpeech(file, await inspectAudio(file));
    expect(result.status).toBe('complete');
    expect(result.analyzedSeconds).toBeCloseTo(120.013, 4);
    expect(result.intervals).toEqual([]);
  }, 30_000);

  it('marks invalid inputs and truncated coverage unavailable, never successful silence', async () => {
    const audio = await inspectAudio(fixture);
    const mismatched = await analyzeSpeech(fixture, { ...audio, duration: audio.duration + 2 });
    expect(mismatched.status).toBe('unavailable');
    expect(mismatched.reason).toContain('duration');
    expect(mismatched.intervals).toEqual([]);
    const file = path.join(directory, 'playlist.wav');
    await fs.writeFile(file, 'ffconcat version 1.0\nfile /etc/passwd\n');
    const invalid = await analyzeSpeech(file, audio);
    expect(invalid.status).toBe('unavailable');
    expect(invalid.reason).not.toContain('/etc/passwd');
    expect(invalid.reason).not.toContain(directory);
  });

  it('rejects a changed model without inferring or claiming silence', async () => {
    const audio = await inspectAudio(fixture);
    vi.mocked(fs.readFile).mockResolvedValueOnce(Buffer.from('changed model'));
    const result = await analyzeSpeech(fixture, audio);
    expect(result.status).toBe('unavailable');
    expect(result.reason).toContain('integrity');
    expect(result.analyzedSeconds).toBe(0);
  });

  it('throws AbortError before and during analysis so interrupted work can resume', async () => {
    const file = await generated('cancel.wav', 'anullsrc=r=16000:cl=mono:d=120');
    const audio = await inspectAudio(file);
    const before = new AbortController(); before.abort();
    await expect(analyzeSpeech(file, audio, before.signal)).rejects.toMatchObject({ name: 'AbortError' });
    const running = new AbortController();
    const operation = analyzeSpeech(file, audio, running.signal);
    const timer = setTimeout(() => running.abort(), 100);
    try { await expect(operation).rejects.toMatchObject({ name: 'AbortError' }); }
    finally { clearTimeout(timer); }
    expect((await fs.stat(file)).size).toBe(audio.size);
  });

  it('disables native telemetry before import and creates no runtime files in a fresh process', async () => {
    const scratch = path.join(directory, 'runtime-probe');
    await fs.mkdir(scratch);
    const source = `
      import { analyzeSpeech } from ${JSON.stringify(path.join(root, 'server/vad.ts'))};
      import { inspectAudio } from ${JSON.stringify(path.join(root, 'server/audio.ts'))};
      import { writeFile } from 'node:fs/promises';
      const file = ${JSON.stringify(fixture)};
      const result = await analyzeSpeech(file, await inspectAudio(file));
      if (result.status !== 'complete' || process.env.ORT_DISABLE_TELEMETRY !== '1') process.exit(2);
      await writeFile('analysis-result.json', JSON.stringify({ status: result.status, telemetryDisabled: process.env.ORT_DISABLE_TELEMETRY }));
    `;
    const result = await command(process.execPath,
      ['--import', path.join(root, 'node_modules/tsx/dist/loader.mjs'), '--input-type=module', '-e', source], scratch);
    expect(JSON.parse(await fs.readFile(path.join(scratch, 'analysis-result.json'), 'utf8')))
      .toEqual({ status: 'complete', telemetryDisabled: '1' });
    expect(result.stderr).not.toMatch(/telemetry|device.?id/i);
    expect(await fs.readdir(scratch)).toEqual(['analysis-result.json']);
  });
});
