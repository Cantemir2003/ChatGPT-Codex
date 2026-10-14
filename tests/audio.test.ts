import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, watch } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkFfmpeg, inspectAudio, planBoundaries, prepareChunks } from '../server/audio.js';
import { MAX_CHUNK_BYTES } from '../shared/config.js';

let directory: string;
let ffmpegAvailable = false;
async function ffmpeg(args: string[]): Promise<void> {
  const child = spawn('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
  let error = '';
  child.stderr.on('data', data => { if (error.length < 4096) error += data; });
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(error)));
  });
}
async function makeAudio(name: string, filter: string, codec = 'pcm_s16le'): Promise<string> {
  const file = path.join(directory, name);
  await ffmpeg(['-f', 'lavfi', '-i', filter, '-c:a', codec, file]);
  return file;
}
async function readWav(file: string) {
  const handle = await open(file, 'r');
  try {
    const header = Buffer.alloc(44);
    await handle.read(header, 0, 44, 0);
    return { channels: header.readUInt16LE(22), rate: header.readUInt32LE(24),
      bits: header.readUInt16LE(34), bytes: header.readUInt32LE(40) };
  } finally { await handle.close(); }
}
async function decodedHash(file: string, bits: number): Promise<string> {
  const child = spawn('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-i', file,
    '-map', '0:a:0', '-c:a', `pcm_s${bits}le`, '-f', `s${bits}le`, 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const hash = createHash('sha256');
  child.stdout.on('data', data => hash.update(data));
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error('Test decode failed.')));
  });
  return hash.digest('hex');
}
async function chunkHash(files: string[]): Promise<string> {
  const hash = createHash('sha256');
  for (const file of files) {
    const { bytes } = await readWav(file);
    for await (const buffer of createReadStream(file, { start: 44, end: 44 + bytes - 1 })) hash.update(buffer);
  }
  return hash.digest('hex');
}

beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'lecture-audio-test-'));
  ffmpegAvailable = await checkFfmpeg();
});
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

describe('audio boundary planning', () => {
  it('covers a two-hour lecture in bounded consecutive sections', () => {
    const ends = planBoundaries(7200.123, 300);
    let start = 0;
    for (const end of ends) {
      expect(end).toBeGreaterThan(start);
      expect(end - start).toBeLessThanOrEqual(300.000000001);
      start = end;
    }
    expect(ends.at(-1)).toBe(7200.123);
    expect(ends).toHaveLength(25);
  });
  it('prefers a nearby pause, preserving the pause in the covered timeline', () => {
    const ends = planBoundaries(150, 60, [{ start: 58, end: 59 }, { start: 115, end: 116 }]);
    expect(ends).toEqual([58.5, 115.5, 150]);
  });
  it('ignores invalid and distant pauses, and rejects invalid durations', () => {
    expect(planBoundaries(125, 60, [{ start: 2, end: 4 }, { start: NaN, end: 60 }])).toEqual([60, 120, 125]);
    expect(() => planBoundaries(Infinity, 60)).toThrow();
    expect(() => planBoundaries(120, 0)).toThrow();
  });
});

describe('FFmpeg audio pipeline', () => {
  it('inspects actual content, assigns a trusted upload extension, and preserves the source', async context => {
    if (!ffmpegAvailable) { context.skip(); return; }
    const original = await makeAudio('small.wav', 'sine=frequency=600:sample_rate=16000:duration=1');
    const disguised = path.join(directory, 'recording.m4a');
    const bytes = await readFile(original);
    await writeFile(disguised, bytes);
    const audio = await inspectAudio(disguised);
    expect(audio.codec).toBe('pcm_s16le');
    expect(audio.sampleRate).toBe(16000);
    const chunks = await prepareChunks(disguised, path.join(directory, 'small-chunks'), audio, 5);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].file).toMatch(/\.wav$/);
    expect(await readFile(chunks[0].file)).toEqual(bytes);
    expect(await readFile(disguised)).toEqual(bytes);
  });

  it('splits a long recording at a pause with sample-identical complete coverage', async context => {
    if (!ffmpegAvailable) { context.skip(); return; }
    const file = await makeAudio('long.wav', "aevalsrc=if(between(t\\,57\\,59)\\,0\\,0.2*sin(2*PI*440*t)):s=8000:d=121.123");
    const audio = await inspectAudio(file);
    const chunks = await prepareChunks(file, path.join(directory, 'long-chunks'), audio, 1);
    expect(chunks).toHaveLength(3);
    expect(chunks[0].end).toBeGreaterThanOrEqual(57);
    expect(chunks[0].end).toBeLessThanOrEqual(59);
    let samples = 0;
    for (const [index, chunk] of chunks.entries()) {
      const wav = await readWav(chunk.file);
      expect(wav.rate).toBe(8000);
      expect(wav.channels).toBe(1);
      expect(chunk.start).toBe(index ? chunks[index - 1].end : 0);
      expect(chunk.end - chunk.start).toBeLessThanOrEqual(60);
      samples += wav.bytes / 2;
      expect((await stat(chunk.file)).size).toBeLessThanOrEqual(MAX_CHUNK_BYTES);
    }
    expect(samples).toBe(Math.round(audio.duration * 8000));
    expect(chunks.at(-1)!.end).toBe(samples / 8000);
    expect(await chunkHash(chunks.map(chunk => chunk.file))).toBe(await decodedHash(file, 16));
  }, 30_000);

  it('streams an actual two-hour recording into complete chronological sections', async context => {
    if (!ffmpegAvailable) { context.skip(); return; }
    const file = await makeAudio('two-hours.wav', 'anullsrc=r=8000:cl=mono:d=7200');
    const audio = await inspectAudio(file);
    expect(audio.duration).toBe(7200);
    expect(audio.size).toBeGreaterThan(115_000_000);
    const chunks = await prepareChunks(file, path.join(directory, 'two-hour-chunks'), audio, 5);
    expect(chunks).toHaveLength(24);
    let frames = 0;
    for (const [index, chunk] of chunks.entries()) {
      const wav = await readWav(chunk.file);
      expect(chunk.index).toBe(index);
      expect(chunk.start).toBe(index ? chunks[index - 1].end : 0);
      expect(chunk.end - chunk.start).toBeLessThanOrEqual(300);
      expect(wav.channels).toBe(1);
      expect(wav.rate).toBe(8000);
      expect(wav.bits).toBe(16);
      expect((await stat(chunk.file)).size).toBeLessThanOrEqual(MAX_CHUNK_BYTES);
      frames += wav.bytes / 2;
    }
    expect(frames).toBe(7200 * 8000);
    expect(chunks.at(-1)!.end).toBe(7200);
    expect((await stat(file)).size).toBe(audio.size);
  }, 30_000);

  it('enforces actual upload bytes for high-channel PCM without downmixing', async context => {
    if (!ffmpegAvailable) { context.skip(); return; }
    const file = await makeAudio('multichannel.wav', 'aevalsrc=0.1|0.2|0.3|0.4|0.5|0.6|0.7|0.8:s=48000:d=20', 'pcm_s32le');
    const audio = await inspectAudio(file);
    expect(audio.size).toBeGreaterThan(MAX_CHUNK_BYTES);
    expect(audio.channels).toBe(8);
    const chunks = await prepareChunks(file, path.join(directory, 'multichannel-chunks'), audio, 1);
    expect(chunks).toHaveLength(2);
    let frames = 0;
    for (const chunk of chunks) {
      const wav = await readWav(chunk.file);
      expect(wav.channels).toBe(8);
      expect(wav.rate).toBe(48000);
      expect(wav.bits).toBe(32);
      expect((await stat(chunk.file)).size).toBeLessThanOrEqual(MAX_CHUNK_BYTES);
      expect((await inspectAudio(chunk.file)).channels).toBe(8);
      frames += wav.bytes / 32;
    }
    expect(frames).toBe(20 * 48000);
    expect(await chunkHash(chunks.map(chunk => chunk.file))).toBe(await decodedHash(file, 32));
  }, 30_000);

  it('decodes Voice Memos AAC and ALAC without seek-boundary sample gaps', async context => {
    if (!ffmpegAvailable) { context.skip(); return; }
    for (const codec of ['aac', 'alac']) {
      const file = await makeAudio(`voice-${codec}.m4a`, 'sine=frequency=440:sample_rate=16000:duration=61.031', codec);
      const audio = await inspectAudio(file);
      expect(audio.codec).toBe(codec);
      const chunks = await prepareChunks(file, path.join(directory, `voice-${codec}-chunks`), audio, 1);
      expect(chunks).toHaveLength(2);
      expect(chunks[1].start).toBe(chunks[0].end);
      const { bits } = await readWav(chunks[0].file);
      expect(await chunkHash(chunks.map(chunk => chunk.file))).toBe(await decodedHash(file, bits));
    }
  }, 30_000);

  it('preserves 24-bit PCM precision and correctly pads an odd-sized final WAV section', async context => {
    if (!ffmpegAvailable) { context.skip(); return; }
    const file = await makeAudio('precision.wav', 'sine=sample_rate=8000:duration=61.000125', 'pcm_s24le');
    const audio = await inspectAudio(file);
    const chunks = await prepareChunks(file, path.join(directory, 'precision-chunks'), audio, 1);
    const last = chunks.at(-1)!;
    const wav = await readWav(last.file);
    expect(wav.bits).toBe(24);
    expect(wav.bytes % 2).toBe(1);
    expect((await stat(last.file)).size).toBe(44 + wav.bytes + 1);
    expect(await chunkHash(chunks.map(chunk => chunk.file))).toBe(await decodedHash(file, 24));
  });

  it('rejects empty, unsupported, and playlist inputs without interpreting filenames as arguments', async context => {
    if (!ffmpegAvailable) { context.skip(); return; }
    const empty = path.join(directory, 'empty.m4a');
    await writeFile(empty, '');
    await expect(inspectAudio(empty)).rejects.toThrow('non-empty');
    const unsupported = path.join(directory, 'not-audio.m4a');
    await writeFile(unsupported, 'this is not an audio recording');
    await expect(inspectAudio(unsupported)).rejects.toThrow('could not be decoded');
    const playlist = path.join(directory, 'untrusted.m4a');
    await writeFile(playlist, 'ffconcat version 1.0\nfile /etc/passwd\n');
    await expect(inspectAudio(playlist)).rejects.toThrow('could not be decoded');
    const strange = await makeAudio('-odd $(touch SENTINEL).wav', 'sine=sample_rate=8000:duration=0.1');
    expect((await inspectAudio(strange)).duration).toBeGreaterThan(0);
    await expect(stat(path.join(directory, 'SENTINEL'))).rejects.toThrow();
  });

  it('honors cancellation before and during preparation', async context => {
    if (!ffmpegAvailable) { context.skip(); return; }
    const file = await makeAudio('cancel.wav', 'sine=sample_rate=8000:duration=121');
    const audio = await inspectAudio(file);
    const controller = new AbortController();
    controller.abort();
    await expect(prepareChunks(file, path.join(directory, 'cancel-before'), audio, 1, controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
    const running = new AbortController();
    const operation = prepareChunks(file, path.join(directory, 'cancel-during'), audio, 1, running.signal);
    const timer = setTimeout(() => running.abort(), 15);
    try { await expect(operation).rejects.toMatchObject({ name: 'AbortError' }); }
    finally { clearTimeout(timer); }
    expect((await stat(file)).size).toBe(audio.size);
  });

  it('cancels an active PCM decode and removes incomplete sections while keeping the source', async context => {
    if (!ffmpegAvailable) { context.skip(); return; }
    const file = await makeAudio('cancel-decoding.wav', 'sine=sample_rate=48000:duration=121', 'pcm_s32le');
    const audio = await inspectAudio(file);
    const chunksDir = path.join(directory, 'cancel-decoding-chunks');
    await mkdir(chunksDir);
    const controller = new AbortController();
    const watcher = watch(chunksDir, (_event, filename) => {
      if (filename?.toString().endsWith('.wav')) controller.abort();
    });
    try {
      await expect(prepareChunks(file, chunksDir, audio, 1, controller.signal))
        .rejects.toMatchObject({ name: 'AbortError' });
    } finally { watcher.close(); }
    expect(await readdir(chunksDir)).toEqual([]);
    expect((await stat(file)).size).toBe(audio.size);
  });
});
