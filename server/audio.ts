import { spawn } from 'node:child_process';
import { copyFile, mkdir, open, readdir, rm, stat, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { MAX_CHUNK_BYTES } from '../shared/config.js';
import type { AudioInfo, Chunk } from '../shared/types.js';

// Deliberately exclude playlist, concat and image demuxers. MOV external data
// references are disabled, and FFmpeg cannot use any network protocol.
const INPUT_OPTIONS = ['-protocol_whitelist', 'file,pipe', '-format_whitelist',
  'mov,mp3,wav,flac,ogg,matroska,webm,aac,aiff'];
function decoderInputOptions(format: string): string[] {
  return format.split(',').includes('mov') ? [...INPUT_OPTIONS, '-enable_drefs', '0'] : INPUT_OPTIONS;
}
const MAX_CAPTURE = 1_048_576;
const WAV_HEADER_BYTES = 44;
interface ProbeStream {
  codec_type?: string; codec_name?: string; sample_rate?: string; channels?: number;
  sample_fmt?: string; bits_per_raw_sample?: string; bits_per_sample?: number;
  duration?: string; duration_ts?: number; time_base?: string;
  disposition?: { attached_pic?: number };
}
interface Inspection { audio: AudioInfo; stream: ProbeStream; hasVideo: boolean }
export interface Pause { start: number; end: number }

function abortError(): Error { return new DOMException('Audio preparation was cancelled.', 'AbortError'); }
function checkAbort(signal?: AbortSignal): void { if (signal?.aborted) throw abortError(); }
function preparationError(error: unknown): unknown {
  if (error && typeof error === 'object' && 'code' in error && ['ENOSPC', 'EDQUOT'].includes(String(error.code))) {
    return new Error('There is not enough disk space to prepare this recording. Free some space on your Mac, then resume the lecture.');
  }
  return error;
}

/** Bound process lifetime/output, never invoke a shell, and never expose input metadata in errors. */
function processControl(child: ReturnType<typeof spawn>, timeoutMs: number, signal?: AbortSignal) {
  let stopped: Error | undefined;
  let hardKill: NodeJS.Timeout | undefined;
  const stop = (error: Error) => {
    if (stopped) return;
    stopped = error;
    child.kill('SIGTERM');
    hardKill = setTimeout(() => child.kill('SIGKILL'), 1_000);
    hardKill.unref();
  };
  const onAbort = () => stop(abortError());
  const timeout = setTimeout(() => stop(new Error('Audio processing took too long. Try exporting this recording again.')), timeoutMs);
  timeout.unref();
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const done = new Promise<void>((resolve, reject) => {
    child.once('error', error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        stopped = new Error('FFmpeg or ffprobe is missing. Install FFmpeg using the setup instructions, then restart the app.');
      } else stopped = new Error('The audio processing tool could not start.');
    });
    child.once('close', code => {
      clearTimeout(timeout);
      if (hardKill) clearTimeout(hardKill);
      signal?.removeEventListener('abort', onAbort);
      if (stopped) reject(stopped);
      else if (code !== 0) reject(new Error('This recording could not be decoded. Export a standard audio file from Voice Memos and try again.'));
      else resolve();
    });
  });
  // A stream may fail before its consumer reaches `await done`.
  void done.catch(() => {});
  return { done, stop };
}

async function capture(command: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<string> {
  checkAbort(signal);
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const control = processControl(child, timeoutMs, signal);
  const buffers: Buffer[] = [];
  let length = 0;
  child.stdout.on('data', (data: Buffer) => {
    length += data.length;
    if (length > MAX_CAPTURE) control.stop(new Error('This recording contains too much metadata. Export it again as a standard audio file.'));
    else buffers.push(data);
  });
  child.stderr.resume();
  await control.done;
  return Buffer.concat(buffers).toString('utf8');
}

export async function checkFfmpeg(): Promise<boolean> {
  try {
    await Promise.all([capture('ffmpeg', ['-version'], 8_000), capture('ffprobe', ['-version'], 8_000)]);
    return true;
  } catch { return false; }
}

async function inspect(file: string, signal?: AbortSignal): Promise<Inspection> {
  checkAbort(signal);
  const absolute = path.resolve(file);
  const fileStat = await stat(absolute);
  if (!fileStat.isFile() || fileStat.size === 0) throw new Error('Choose a non-empty audio recording.');
  const output = await capture('ffprobe', ['-v', 'error', ...INPUT_OPTIONS, '-enable_drefs', '0',
    '-show_entries', 'format=format_name,duration:stream=codec_type,codec_name,sample_rate,channels,sample_fmt,bits_per_raw_sample,bits_per_sample,duration,duration_ts,time_base:stream_disposition=attached_pic',
    '-of', 'json', '-i', absolute], 30_000, signal);
  let metadata: { streams?: ProbeStream[]; format?: { duration?: string; format_name?: string } };
  try { metadata = JSON.parse(output); } catch { throw new Error('The audio metadata could not be read.'); }
  const streams = metadata.streams ?? [];
  const audioStreams = streams.filter(stream => stream.codec_type === 'audio');
  if (audioStreams.length !== 1) throw new Error('Choose a recording with one audio track. Files with no audio or multiple audio tracks are not supported.');
  const stream = audioStreams[0];
  const codec = stream.codec_name ?? '';
  if (!/^(aac|alac|mp3|mp2|flac|opus|vorbis|pcm_[a-z0-9_]+)$/.test(codec)) {
    throw new Error('This audio codec is not supported. Export a standard M4A or WAV recording and try again.');
  }
  const duration = Number(stream.duration ?? metadata.format?.duration);
  const sampleRate = Number(stream.sample_rate);
  const channels = Number(stream.channels);
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isInteger(sampleRate) || sampleRate <= 0 ||
      sampleRate > 768_000 || !Number.isInteger(channels) || channels < 1 || channels > 64) {
    throw new Error('This recording has unsupported or incomplete audio metadata. Export it again from Voice Memos.');
  }
  return {
    audio: { duration, size: fileStat.size, codec, sampleRate, channels, format: metadata.format?.format_name ?? '' },
    stream,
    hasVideo: streams.some(item => item.codec_type === 'video' && !item.disposition?.attached_pic),
  };
}

export async function inspectAudio(file: string): Promise<AudioInfo> { return (await inspect(file)).audio; }

/** Boundaries never delete silence. Each value ends one chunk and starts the next. */
export function planBoundaries(duration: number, maxSeconds: number, pauses: Pause[] = []): number[] {
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(maxSeconds) || maxSeconds <= 0) {
    throw new Error('Audio duration and chunk duration must be positive.');
  }
  const sorted = pauses.filter(pause => Number.isFinite(pause.start) && Number.isFinite(pause.end) && pause.end > pause.start)
    .sort((a, b) => a.start - b.start);
  const result: number[] = [];
  let start = 0;
  let firstPause = 0;
  while (duration - start > maxSeconds + 1e-9) {
    const ideal = start + maxSeconds;
    const earliest = ideal - Math.min(8, maxSeconds * 0.15);
    while (firstPause < sorted.length && sorted[firstPause].end < earliest) firstPause++;
    let chosen: number | undefined;
    for (let index = firstPause; index < sorted.length && sorted[index].start <= ideal; index++) {
      const pause = sorted[index];
      if (pause.end < earliest) continue;
      const candidate = pause.end >= ideal ? ideal : (Math.max(earliest, pause.start) + pause.end) / 2;
      if (candidate > start && (chosen === undefined || candidate > chosen)) chosen = candidate;
    }
    start = chosen ?? ideal;
    result.push(start);
    if (result.length > 100_000) throw new Error('This recording would require too many audio sections.');
  }
  result.push(duration);
  return result;
}

function processingTimeout(duration: number): number {
  return Math.min(6 * 60 * 60_000, Math.max(60_000, (60 + duration * 2) * 1_000));
}

async function findPauses(file: string, duration: number, format: string, signal?: AbortSignal): Promise<Pause[]> {
  checkAbort(signal);
  const child = spawn('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'info', ...decoderInputOptions(format), '-i', file,
    '-map', '0:a:0', '-vn', '-sn', '-dn', '-af', 'silencedetect=noise=-35dB:d=0.35', '-f', 'null', '-'],
  { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  const control = processControl(child, processingTimeout(duration), signal);
  const pauses: Pause[] = [];
  let unfinished = '';
  let start: number | undefined;
  const parseLine = (line: string) => {
    const begin = /silence_start: ([\d.e+-]+)/.exec(line);
    if (begin) start = Number(begin[1]);
    const end = /silence_end: ([\d.e+-]+)/.exec(line);
    if (end && start !== undefined) {
      // Silence detection is a convenience; cap its bookkeeping, not the audio.
      if (pauses.length < 100_000) pauses.push({ start: Math.max(0, start), end: Number(end[1]) });
      start = undefined;
    }
  };
  child.stderr.on('data', (data: Buffer) => {
    unfinished += data.toString('utf8');
    let newline: number;
    while ((newline = unfinished.indexOf('\n')) >= 0) {
      parseLine(unfinished.slice(0, newline));
      unfinished = unfinished.slice(newline + 1);
    }
    if (unfinished.length > 16_384) unfinished = unfinished.slice(-8_192);
  });
  await control.done;
  parseLine(unfinished);
  if (start !== undefined && pauses.length < 100_000) pauses.push({ start, end: duration });
  return pauses;
}

function directExtension(info: Inspection): string | undefined {
  if (info.hasVideo) return undefined;
  const formats = new Set(info.audio.format.split(','));
  if (formats.has('mov') && ['aac', 'alac'].includes(info.audio.codec)) return '.m4a';
  if (formats.has('mp3') && info.audio.codec === 'mp3') return '.mp3';
  if (formats.has('wav') && /^pcm_/.test(info.audio.codec)) return '.wav';
  // ffprobe reports the same demuxer name for MKV and WebM. Normalize both
  // instead of assigning an unverified WebM extension to a Matroska file.
  return undefined;
}

function pcmBits(stream: ProbeStream): 16 | 24 | 32 {
  const bits = Number(stream.bits_per_raw_sample || stream.bits_per_sample);
  if (bits > 0) return bits <= 16 ? 16 : bits <= 24 ? 24 : 32;
  if (/^(u8|s16)/.test(stream.sample_fmt ?? '')) return 16;
  // AAC usually decodes to float. 32-bit PCM avoids an unnecessary 16-bit reduction.
  return 32;
}

function wavHeader(bytes: number, sampleRate: number, channels: number, bits: number): Buffer {
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  header.write('RIFF', 0); header.writeUInt32LE(bytes + 36 + bytes % 2, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * channels * bits / 8, 28);
  header.writeUInt16LE(channels * bits / 8, 32); header.writeUInt16LE(bits, 34);
  header.write('data', 36); header.writeUInt32LE(bytes, 40);
  return header;
}

async function writeAll(handle: FileHandle, data: Buffer, position: number): Promise<void> {
  let offset = 0;
  while (offset < data.length) {
    const { bytesWritten } = await handle.write(data, offset, data.length - offset, position + offset);
    if (!bytesWritten) throw new Error('Audio could not be saved. Check available disk space.');
    offset += bytesWritten;
  }
}

/** Decode once, stream PCM to disk, and split only between complete samples. */
export async function prepareChunks(sourcePath: string, outputDir: string, _audio: AudioInfo,
  chunkMinutes: number, signal?: AbortSignal): Promise<Chunk[]> {
  checkAbort(signal);
  if (!Number.isFinite(chunkMinutes) || chunkMinutes < 1 || chunkMinutes > 10) {
    throw new Error('Choose an audio section length between 1 and 10 minutes.');
  }
  const source = path.resolve(sourcePath);
  const directory = path.resolve(outputDir);
  const inspection = await inspect(source, signal);
  const audio = inspection.audio; // Trust fresh media inspection, never browser metadata.
  await mkdir(directory, { recursive: true });
  // A failed preparation has no manifest entries. Clean up only files owned by this pipeline.
  for (const name of await readdir(directory)) {
    if (/^chunk-\d{6}\.(wav|m4a|mp3|webm)$/.test(name)) {
      const old = path.join(directory, name);
      if (old !== source) await rm(old, { force: true });
    }
  }
  const extension = directExtension(inspection);
  if (extension && audio.size <= MAX_CHUNK_BYTES && audio.duration <= chunkMinutes * 60) {
    const file = path.join(directory, `chunk-000000${extension}`);
    if (file === source) throw new Error('Audio source and temporary section paths must differ.');
    try {
      await copyFile(source, file);
      checkAbort(signal);
      return [{ id: 'chunk-000000', index: 0, start: 0, end: audio.duration, file, status: 'pending', attempts: [] }];
    } catch (error) {
      await rm(file, { force: true }).catch(() => {});
      throw preparationError(error);
    }
  }
  const bits = pcmBits(inspection.stream);
  const bytesPerFrame = audio.channels * bits / 8;
  const maxFrames = Math.min(Math.floor((MAX_CHUNK_BYTES - WAV_HEADER_BYTES - 1) / bytesPerFrame),
    Math.floor(chunkMinutes * 60 * audio.sampleRate));
  const maxSeconds = maxFrames / audio.sampleRate;
  const pauses = await findPauses(source, audio.duration, audio.format, signal);
  const boundaries = planBoundaries(audio.duration, maxSeconds, pauses)
    .slice(0, -1).map(seconds => Math.floor(seconds * audio.sampleRate));
  const child = spawn('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', ...decoderInputOptions(audio.format), '-i', source,
    '-map', '0:a:0', '-vn', '-sn', '-dn', '-map_metadata', '-1', '-c:a', `pcm_s${bits}le`,
    '-f', `s${bits}le`, 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const control = processControl(child, processingTimeout(audio.duration), signal);
  child.stderr.resume();
  const chunks: Chunk[] = [];
  let handle: FileHandle | undefined;
  let file = '';
  let written = 0;
  let totalFrames = 0;
  let capacity = 0;
  let carry = Buffer.alloc(0);
  const finishChunk = async () => {
    if (!handle) return;
    await writeAll(handle, wavHeader(written, audio.sampleRate, audio.channels, bits), 0);
    if (written % 2) await writeAll(handle, Buffer.alloc(1), WAV_HEADER_BYTES + written);
    await handle.close(); handle = undefined;
    const actual = await stat(file);
    if (actual.size > MAX_CHUNK_BYTES || actual.size !== written + WAV_HEADER_BYTES + written % 2) {
      throw new Error('A prepared audio section did not meet the upload size limit.');
    }
    const frames = written / bytesPerFrame;
    chunks.push({ id: `chunk-${String(chunks.length).padStart(6, '0')}`, index: chunks.length,
      start: totalFrames / audio.sampleRate, end: (totalFrames + frames) / audio.sampleRate,
      file, status: 'pending', attempts: [] });
    totalFrames += frames;
  };
  try {
    for await (const value of child.stdout) {
      checkAbort(signal);
      const received = value as Buffer;
      const buffer = carry.length ? Buffer.concat([carry, received]) : received;
      const available = buffer.length - buffer.length % bytesPerFrame;
      carry = Buffer.from(buffer.subarray(available));
      let offset = 0;
      while (offset < available) {
        if (!handle) {
          file = path.join(directory, `chunk-${String(chunks.length).padStart(6, '0')}.wav`);
          if (file === source) throw new Error('Audio source and temporary section paths must differ.');
          handle = await open(file, 'wx');
          written = 0;
          const planned = boundaries[chunks.length];
          capacity = Math.max(1, Math.min(maxFrames, planned ? planned - totalFrames : maxFrames)) * bytesPerFrame;
          await writeAll(handle, wavHeader(0, audio.sampleRate, audio.channels, bits), 0);
        }
        const amount = Math.min(available - offset, capacity - written);
        await writeAll(handle, buffer.subarray(offset, offset + amount), WAV_HEADER_BYTES + written);
        written += amount; offset += amount;
        if (written === capacity) await finishChunk();
      }
    }
    await control.done;
    checkAbort(signal);
    if (carry.length) throw new Error('The audio decoder returned an incomplete sample. Export the recording again.');
    await finishChunk();
    if (!chunks.length) throw new Error('This recording contains no decodable audio.');
    return chunks;
  } catch (error) {
    control.stop(error instanceof Error ? error : new Error('Audio preparation failed.'));
    await control.done.catch(() => {});
    if (handle) await handle.close().catch(() => {});
    // Incomplete preparation is never reusable; the original upload remains intact.
    for (const item of new Set([...chunks.map(chunk => chunk.file), file])) {
      if (item) await rm(item, { force: true }).catch(() => {});
    }
    throw preparationError(error);
  }
}
