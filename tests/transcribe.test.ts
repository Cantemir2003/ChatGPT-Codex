import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyError, requestFields, transcribe } from '../server/transcribe.js';
import { DEFAULTS } from '../shared/config.js';
import type { TranscriptionSettings } from '../shared/types.js';

let folder: string;
let file: string;
beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'lecture-transcribe-'));
  file = join(folder, 'section.wav'); await writeFile(file, 'fake-audio-for-mocked-fetch');
});
afterEach(async () => { vi.unstubAllGlobals(); await rm(folder, { recursive: true, force: true }); });

function input(settings: TranscriptionSettings) {
  return { file, settings, key: 'sk-fake-sdk-test-only', signal: new AbortController().signal, onDelta: vi.fn(), onPhase: vi.fn() };
}
function sse(events: unknown[]) {
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('exact-model transcription requests', () => {
  it('sends only supported gpt-transcribe settings and omits empty hints', () => {
    expect(requestFields({ languages: [], prompt: '', keywords: [], stream: false })).toEqual({ model: 'gpt-transcribe', response_format: 'json', stream: false });
    const fields = requestFields({ languages: ['ro', 'en'], prompt: 'Curs în limba română.', keywords: ['Știință', 'ameloblast'], stream: true });
    expect(fields).toEqual({ model: 'gpt-transcribe', response_format: 'json', stream: true, languages: ['ro', 'en'], prompt: 'Curs în limba română.', keywords: ['Știință', 'ameloblast'] });
    for (const unsupported of ['language', 'temperature', 'timestamp_granularities', 'diarization', 'vad_filter']) expect(fields).not.toHaveProperty(unsupported);
  });

  it('serializes the exact supported request through the official SDK without a live call', async () => {
    let request: Request | undefined;
    let form: FormData | undefined;
    const mockedFetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      request = new Request(url, init);
      form = await request.formData();
      return new Response(JSON.stringify({ text: '  Și, și...\nțesut.  ', usage: { seconds: 60 } }), { headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', mockedFetch);
    const args = input({ ...DEFAULTS.transcription, languages: ['ro', 'en'], keywords: ['Știință', 'smalț'], stream: false });
    const result = await transcribe(args);
    expect(mockedFetch).toHaveBeenCalledOnce();
    expect(request?.url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(request?.headers.get('authorization')).toBe('Bearer sk-fake-sdk-test-only');
    expect(form?.get('model')).toBe('gpt-transcribe');
    expect(form?.get('response_format')).toBe('json');
    expect(form?.get('stream')).toBe('false');
    expect(form?.getAll('languages[]')).toEqual(['ro', 'en']);
    expect(form?.getAll('keywords[]')).toEqual(['Știință', 'smalț']);
    expect(form?.has('language')).toBe(false);
    expect(await (form?.get('file') as File).text()).toBe('fake-audio-for-mocked-fetch');
    expect(result).toEqual({ text: '  Și, și...\nțesut.  ', usage: { seconds: 60 } });
    expect(args.onDelta).not.toHaveBeenCalled();
  });

  it.each([
    ['empty text', { text: '', usage: { seconds: 60 } }],
    ['whitespace text', { text: '  \n\t ', usage: { seconds: 60 } }],
    ['missing text', { usage: { seconds: 60 } }],
    ['null text', { text: null, usage: { seconds: 60 } }],
    ['numeric text', { text: 42, usage: { seconds: 60 } }],
  ])('preserves a successful JSON response with %s without another paid request', async (_label, response) => {
    const mockedFetch = vi.fn(async () => new Response(JSON.stringify(response), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', mockedFetch);
    const args = input({ ...DEFAULTS.transcription, stream: false });
    await expect(transcribe(args)).resolves.toStrictEqual(response);
    expect(mockedFetch).toHaveBeenCalledOnce();
    expect(args.onDelta).not.toHaveBeenCalled();
  });

  it('treats the final streaming event as authoritative and preserves raw events', async () => {
    const events = [
      { type: 'transcript.text.delta', delta: 'sint' },
      { type: 'transcript.text.delta', delta: 'eza' },
      { type: 'transcript.text.done', text: '  Sinteză. Sinteză.\n', usage: { total_tokens: 22 } },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => sse(events)));
    const args = input({ ...DEFAULTS.transcription, stream: true });
    const result = await transcribe(args);
    expect(args.onDelta.mock.calls).toEqual([['sint'], ['eza']]);
    expect(args.onPhase.mock.calls).toEqual([['uploading'], ['transcribing']]);
    expect(result).toStrictEqual({ ...events[2], events });
  });

  it.each([
    ['empty text', { text: '' }],
    ['whitespace text', { text: '  \n\t ' }],
    ['missing text', {}],
    ['null text', { text: null }],
    ['numeric text', { text: 42 }],
  ])('preserves a terminal streaming response with %s without substituting deltas or retrying', async (_label, fields) => {
    const terminal = { type: 'transcript.text.done', ...fields, usage: { total_tokens: 22 } };
    const events = [
      { type: 'transcript.text.delta', delta: 'partial only' },
      terminal,
    ];
    const mockedFetch = vi.fn(async () => sse(events));
    vi.stubGlobal('fetch', mockedFetch);
    const args = input({ ...DEFAULTS.transcription, stream: true });
    await expect(transcribe(args)).resolves.toStrictEqual({ ...terminal, events });
    expect(mockedFetch).toHaveBeenCalledOnce();
    expect(args.onDelta.mock.calls).toEqual([['partial only']]);
    expect(args.onPhase.mock.calls).toEqual([['uploading'], ['transcribing']]);
  });

  it('rejects a stream ending without a final event instead of exporting fragments', async () => {
    const mockedFetch = vi.fn(async () => sse([{ type: 'transcript.text.delta', delta: 'partial only' }]));
    vi.stubGlobal('fetch', mockedFetch);
    const args = input({ ...DEFAULTS.transcription, stream: true });
    await expect(transcribe(args)).rejects.toThrow('incomplete_stream');
    expect(mockedFetch).toHaveBeenCalledOnce();
    expect(args.onDelta).toHaveBeenCalledWith('partial only');
  });

  it.each([{ text: '' }, {}])('keeps a terminal response %j even if the transport fails immediately afterward', async fields => {
    const events = [
      { type: 'transcript.text.delta', delta: 'provisional text' },
      { type: 'transcript.text.done', ...fields },
    ];
    const bytes = new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ === 0) controller.enqueue(bytes);
        else controller.error(new Error('Connection reset after the terminal response.'));
      },
    });
    const mockedFetch = vi.fn(async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', mockedFetch);
    const args = input({ ...DEFAULTS.transcription, stream: true });
    await expect(transcribe(args)).resolves.toStrictEqual({ ...events[1], events });
    expect(args.onDelta).toHaveBeenCalledWith('provisional text');
    expect(mockedFetch).toHaveBeenCalledOnce();
  });

  it('disables SDK retries so the persistent engine controls all billable attempts', async () => {
    const mockedFetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'test error', type: 'server_error' } }), {
      status: 503, headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', mockedFetch);
    await expect(transcribe(input({ ...DEFAULTS.transcription, stream: false }))).rejects.toMatchObject({ status: 503 });
    expect(mockedFetch).toHaveBeenCalledOnce();
  });
});

describe('safe actionable API failures', () => {
  it.each([null, undefined, 'secret sk-private-key'])('handles arbitrary thrown values safely: %s', error => {
    const result = classifyError(error);
    expect(result).toMatchObject({ retryable: true, uncertain: true, stopQueue: false });
    expect(result.message).not.toContain('sk-private-key');
  });

  it.each([
    [{ status: 401 }, false, false, true],
    [{ status: 403 }, false, false, true],
    [{ status: 404 }, false, false, true],
    [{ status: 400 }, false, false, true],
    [{ status: 413 }, false, false, true],
    [{ status: 429 }, true, false, false],
    [{ status: 429, code: 'insufficient_quota' }, false, false, true],
    [{ status: 429, code: 'billing_hard_limit_reached' }, false, false, true],
    [{ status: 408 }, true, true, false],
    [{ status: 503 }, true, true, false],
    [{ name: 'APIConnectionError' }, true, true, false],
  ])('classifies %j without exposing the provider message', (details, retryable, uncertain, stopQueue) => {
    const error = Object.assign(new Error('secret sk-private-key /private/audio/lecture.m4a'), details);
    const result = classifyError(error);
    expect(result).toMatchObject({ retryable, uncertain, stopQueue });
    expect(result.message).not.toContain('sk-private-key');
    expect(result.message).not.toContain('/private/audio');
  });
});
