import OpenAI from 'openai';
import { createReadStream } from 'node:fs';
import { MODEL } from '../shared/config.js';
// Only the fields independently verified for this exact model are allowed here.
export function requestFields(settings) { return { model: MODEL, response_format: 'json', stream: settings.stream, ...(settings.prompt ? { prompt: settings.prompt } : {}), ...(settings.languages.length ? { languages: settings.languages } : {}), ...(settings.keywords.length ? { keywords: settings.keywords } : {}) }; }
export const transcribe = async ({ file, settings, key, signal, onDelta, onPhase }) => {
    const client = new OpenAI({ apiKey: key, baseURL: 'https://api.openai.com/v1', maxRetries: 0, timeout: 10 * 60_000 });
    const audio = createReadStream(file);
    onPhase('uploading');
    try {
        const fields = { ...requestFields(settings), file: audio };
        if (settings.stream) {
            const stream = await client.audio.transcriptions.create({ ...fields, stream: true }, { signal });
            onPhase('transcribing');
            const events = [];
            for await (const event of stream) {
                events.push(event);
                if (event.type === 'transcript.text.delta' && typeof event.delta === 'string')
                    onDelta(event.delta);
                // The terminal event is authoritative. A later socket failure must not discard
                // a successful, potentially billable response or trigger another request.
                if (event.type === 'transcript.text.done')
                    return { ...event, events };
                if (event.type === 'error')
                    throw new Error('stream_error');
            }
            throw new Error('incomplete_stream');
        }
        // The SDK does not expose a reliable upload-finished signal for non-streaming requests.
        // UI describes this combined phase as sending audio and waiting for transcription.
        const result = await client.audio.transcriptions.create({ ...fields, stream: false }, { signal });
        return result;
    }
    finally {
        audio.destroy();
    }
};
export function classifyError(error) {
    const e = (error && typeof error === 'object' ? error : {});
    if (e.status === 401)
        return { message: 'OpenAI rejected the API key. Replace it in Settings, then resume this lecture.', retryable: false, uncertain: false, stopQueue: true };
    if (e.code === 'insufficient_quota' || e.code === 'billing_hard_limit_reached')
        return { message: 'Your OpenAI API credit or spending limit has been reached. Check billing and prepaid credit, then resume.', retryable: false, uncertain: false, stopQueue: true };
    if (e.status === 403 || e.status === 404)
        return { message: 'Your OpenAI project cannot access gpt-transcribe. Check model access and project permissions. This app will not use a different model.', retryable: false, uncertain: false, stopQueue: true };
    if (e.status === 400 || e.status === 422)
        return { message: 'OpenAI rejected this audio or a transcription setting. Check the context length and vocabulary. Import the recording again with shorter context or corrected settings; completed sections remain saved.', retryable: false, uncertain: false, stopQueue: true };
    if (e.status === 413)
        return { message: 'OpenAI rejected the section size. Import again with a shorter section duration. Completed sections are saved.', retryable: false, uncertain: false, stopQueue: true };
    if (e.status === 429)
        return { message: 'OpenAI’s rate limit was reached. Wait a little, then resume. Completed sections are saved.', retryable: true, uncertain: false, stopQueue: false };
    if (e.status === 408 || !e.status || e.status >= 500)
        return { message: 'The OpenAI request was interrupted or the service is temporarily unavailable. Check your connection and resume. A timed-out or interrupted request may still be charged.', retryable: true, uncertain: true, stopQueue: false };
    return { message: 'OpenAI could not complete the request. Check your API project settings, then resume. Completed sections are saved.', retryable: false, uncertain: false, stopQueue: true };
}
