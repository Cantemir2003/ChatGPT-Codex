import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AudioInfo, SpeechAnalysis } from '../shared/types.js';
import type { InferenceSession, Tensor } from 'onnxruntime-node';

export const VAD_MODEL = 'silero-vad';
export const VAD_VERSION = '6.2.3';
export const VAD_MODEL_SHA256 = '1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3';
const RATE = 16_000;
const FRAME = 512;
const CONTEXT = 64;
const ONSET = 0.5;
const OFFSET = 0.35;
const MIN_SPEECH = RATE * 0.25;
const MIN_SILENCE = RATE * 0.1;
const PADDING = RATE * 0.03;
const MAX_INTERVALS = 100_000;
const FORMATS = 'mov,mp3,wav,flac,ogg,matroska,webm,aac,aiff';

class VadFailure extends Error {}
const aborted = () => new DOMException('Local speech analysis was cancelled.', 'AbortError');
function checkAbort(signal?: AbortSignal): void { if (signal?.aborted) throw aborted(); }

async function modelBytes(): Promise<Buffer> {
  // Both tsx development and dist/server production resolve a bundled local file.
  // There is deliberately no environment override, remote URL, or model download.
  const candidates = ['../models/', '../../models/'].map(relative =>
    fileURLToPath(new URL(`${relative}silero_vad_v${VAD_VERSION}.onnx`, import.meta.url)));
  for (const file of candidates) {
    let info;
    try { info = await stat(file); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new VadFailure('The bundled speech model could not be read. Run setup again.');
    }
    if (!info.isFile() || info.size > 4_000_000) throw new VadFailure('The bundled speech model failed its integrity check. Run setup again.');
    const bytes = await readFile(file);
    if (createHash('sha256').update(bytes).digest('hex') !== VAD_MODEL_SHA256) {
      throw new VadFailure('The bundled speech model failed its integrity check. Run setup again.');
    }
    return bytes;
  }
  throw new VadFailure('The bundled speech model is missing. Run setup again.');
}

/** Streaming hysteresis follows Silero's documented default speech thresholds. */
export class SpeechIntervals {
  private start: number | undefined;
  private possibleEnd: number | undefined;
  private readonly ranges: { start: number; end: number }[] = [];

  accept(probability: number, frameStart: number): void {
    if (!Number.isFinite(probability) || probability < 0 || probability > 1 || !Number.isFinite(frameStart) || frameStart < 0) {
      throw new VadFailure('The local speech model returned an invalid result.');
    }
    if (probability >= ONSET) {
      this.possibleEnd = undefined;
      if (this.start === undefined) this.start = frameStart;
    } else if (probability < OFFSET && this.start !== undefined) {
      this.possibleEnd ??= frameStart;
      if (frameStart - this.possibleEnd >= MIN_SILENCE) {
        this.append(this.start, this.possibleEnd);
        this.start = undefined;
        this.possibleEnd = undefined;
      }
    }
  }

  private append(start: number, end: number): void {
    if (end - start < MIN_SPEECH) return;
    if (this.ranges.length >= MAX_INTERVALS) throw new VadFailure('This recording has too many speech intervals for local analysis.');
    this.ranges.push({ start, end });
  }

  finish(totalSamples: number): { start: number; end: number }[] {
    if (this.start !== undefined) this.append(this.start, totalSamples);
    this.start = undefined;
    const padded: { start: number; end: number }[] = [];
    for (const range of this.ranges) {
      const start = Math.max(0, Math.min(totalSamples, range.start - PADDING));
      const end = Math.max(start, Math.min(totalSamples, range.end + PADDING));
      if (end <= start) continue;
      const previous = padded.at(-1);
      if (previous && start <= previous.end) previous.end = Math.max(previous.end, end);
      else padded.push({ start, end });
    }
    return padded.map(range => ({ start: range.start / RATE, end: range.end / RATE }));
  }
}

/** Analyze a temporary mono/16-kHz view; never modify the source or upload sections. */
export async function analyzeSpeech(sourcePath: string, audio: AudioInfo, signal?: AbortSignal): Promise<SpeechAnalysis> {
  checkAbort(signal);
  let session: InferenceSession | undefined;
  let state: Tensor | undefined;
  let rateTensor: Tensor | undefined;
  let samples = 0;
  try {
    if (!Number.isFinite(audio.duration) || audio.duration <= 0 || !Number.isFinite(audio.sampleRate) || audio.sampleRate <= 0) {
      throw new VadFailure('The recording duration could not be verified for local speech analysis.');
    }
    const source = path.resolve(sourcePath);
    if (!(await stat(source)).isFile()) throw new VadFailure('The recording is unavailable for local speech analysis.');
    const bytes = await modelBytes();
    checkAbort(signal);
    // Official ORT POSIX full opt-out: must be set BEFORE the native library loads.
    // It prevents uploader creation, telemetry events and device-id persistence.
    process.env.ORT_DISABLE_TELEMETRY = '1';
    const ort = await import('onnxruntime-node');
    ort.env.logLevel = 'error';
    session = await ort.InferenceSession.create(bytes, {
      executionProviders: ['cpu'], intraOpNumThreads: 1, interOpNumThreads: 1,
      executionMode: 'sequential', enableProfiling: false, logSeverityLevel: 3,
    });
    checkAbort(signal);
    state = new ort.Tensor('float32', new Float32Array(2 * 128), [2, 1, 128]);
    rateTensor = new ort.Tensor('int64', BigInt64Array.from([BigInt(RATE)]), []);
    const input = new Float32Array(CONTEXT + FRAME);
    const frame = Buffer.alloc(FRAME * 4);
    let frameBytes = 0;
    const detector = new SpeechIntervals();
    const runFrame = async (validSamples: number) => {
      checkAbort(signal);
      for (let index = 0; index < FRAME; index++) input[CONTEXT + index] = frame.readFloatLE(index * 4);
      const inputTensor = new ort.Tensor('float32', input, [1, CONTEXT + FRAME]);
      let result: Awaited<ReturnType<InferenceSession['run']>>;
      try { result = await session!.run({ input: inputTensor, state: state!, sr: rateTensor! }); }
      finally { inputTensor.dispose(); }
      const probability = Number(result.output.data[0]);
      if (result.stateN.type !== 'float32' || result.stateN.data.length !== 256) {
        result.output.dispose(); result.stateN.dispose();
        throw new VadFailure('The local speech model returned an invalid result.');
      }
      state!.dispose(); state = result.stateN;
      result.output.dispose();
      detector.accept(probability, samples);
      samples += validSamples;
      // Context is the last 64 *real* samples for the next 512-sample frame.
      input.copyWithin(0, FRAME, FRAME + CONTEXT);
    };
    const inputOptions = ['-protocol_whitelist', 'file,pipe', '-format_whitelist', FORMATS];
    if (audio.format.split(',').includes('mov')) inputOptions.push('-enable_drefs', '0');
    const child = spawn('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', ...inputOptions,
      '-i', source, '-map', '0:a:0', '-vn', '-sn', '-dn', '-map_metadata', '-1',
      '-ac', '1', '-ar', String(RATE), '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1'],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stderr.resume();
    let failure: Error | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const stop = (error: Error) => {
      if (failure) return;
      failure = error;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1_000);
      killTimer.unref();
    };
    const onAbort = () => stop(aborted());
    const timeoutMs = Math.min(6 * 60 * 60_000, Math.max(60_000, (60 + audio.duration * 2) * 1000));
    const timer = setTimeout(() => stop(new VadFailure('Local speech analysis took too long. Transcription remains available.')), timeoutMs);
    timer.unref();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const done = new Promise<void>((resolve, reject) => {
      child.once('error', () => { failure ??= new VadFailure('FFmpeg could not start local speech analysis. Check the app setup.'); });
      child.once('close', code => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        signal?.removeEventListener('abort', onAbort);
        if (failure) reject(failure);
        else if (code !== 0) reject(new VadFailure('This recording could not be fully decoded for local speech analysis.'));
        else resolve();
      });
    });
    void done.catch(() => {});
    try {
      // Awaiting every frame applies backpressure to FFmpeg; no recording-sized buffer.
      for await (const value of child.stdout) {
        const buffer = value as Buffer;
        let offset = 0;
        while (offset < buffer.length) {
          checkAbort(signal);
          if (failure) throw failure;
          const copied = Math.min(frame.length - frameBytes, buffer.length - offset);
          buffer.copy(frame, frameBytes, offset, offset + copied);
          offset += copied; frameBytes += copied;
          if (frameBytes === frame.length) { await runFrame(FRAME); frameBytes = 0; }
        }
      }
      await done;
      checkAbort(signal);
      if (frameBytes % 4) throw new VadFailure('The recording ended with an incomplete audio sample.');
      if (frameBytes) {
        frame.fill(0, frameBytes);
        await runFrame(frameBytes / 4);
      }
      if (!samples) throw new VadFailure('The recording contains no decodable audio for local speech analysis.');
    } catch (error) {
      stop(error instanceof Error ? error : new VadFailure('Local speech analysis could not be completed.'));
      child.stdout.destroy();
      await done.catch(() => {});
      throw error;
    }
    const decodedSeconds = samples / RATE;
    // Codec padding and resampling may round by one compressed frame. Larger
    // mismatches indicate truncation/stale metadata, never a successful silence result.
    const tolerance = Math.min(0.25, Math.max(0.1, 2048 / audio.sampleRate));
    if (Math.abs(decodedSeconds - audio.duration) > tolerance) {
      throw new VadFailure('Local speech analysis did not cover the recording duration. Transcription remains available.');
    }
    const analyzedSeconds = Math.min(decodedSeconds, audio.duration);
    const intervals = detector.finish(Math.min(samples, audio.duration * RATE));
    return { status: 'complete', model: VAD_MODEL, version: VAD_VERSION, intervals,
      speechSeconds: intervals.reduce((total, interval) => total + interval.end - interval.start, 0), analyzedSeconds };
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw aborted();
    return { status: 'unavailable', model: VAD_MODEL, version: VAD_VERSION, intervals: [], speechSeconds: 0,
      analyzedSeconds: 0, reason: error instanceof VadFailure ? error.message : 'Local speech analysis could not be completed. Transcription remains available.' };
  } finally {
    rateTensor?.dispose();
    state?.dispose();
    await session?.release().catch(() => {});
  }
}
