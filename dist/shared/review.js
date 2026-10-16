/** Versioned, deliberately conservative triage rules, not a completeness score. */
export const REVIEW_RULES = { version: '1', minSpeechSeconds: 60, minFallbackSeconds: 120, minWordsPerMinute: 10 };
export const REVIEW_EXPLANATION = 'Verificare orientativă: sub 10 cuvinte/minut pentru minimum 60 s de vorbire detectată local. Dacă analiza vorbirii lipsește, folosim durata întregului fragment (minimum 2 minute). Detectorul poate greși. Lipsa avertismentelor nu garantează o transcriere completă; nu putem localiza omisiuni în interiorul unui fragment fără aliniere temporală.';
export function isChunkFinished(chunk) {
    return chunk.status === 'complete' || chunk.status === 'no_text';
}
/** Preserve the API text exactly. Only the classification uses trim(). */
export function applyResponse(chunk, response) {
    const hasText = response !== null && typeof response === 'object' && Object.hasOwn(response, 'text');
    const value = hasText ? response.text : undefined;
    chunk.text = typeof value === 'string' ? value : undefined;
    chunk.noTextReason = !hasText ? 'missing_text' : typeof value !== 'string' ? 'invalid_text'
        : value.length === 0 ? 'empty' : value.trim().length === 0 ? 'whitespace' : undefined;
    chunk.status = chunk.noTextReason ? 'no_text' : 'complete';
}
export function countWords(text) {
    return text.match(/[\p{L}\p{N}]+(?:[’'\-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}
/** Union clipped intervals so adjacent/overlapping frames never overcount speech. */
export function speechInRange(intervals, start, end) {
    let total = 0, cursor = start;
    for (const range of intervals.filter(r => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start)
        .map(r => ({ start: Math.max(start, r.start), end: Math.min(end, r.end) })).filter(r => r.end > r.start)
        .sort((a, b) => a.start - b.start)) {
        const from = Math.max(cursor, range.start);
        if (range.end > from)
            total += range.end - from;
        cursor = Math.max(cursor, range.end);
    }
    return total;
}
/** Optional saved analysis may come from an older/damaged manifest; fail visibly. */
export function normalizeSpeech(value, duration) {
    if (value === undefined)
        return;
    const data = value && typeof value === 'object' ? value : {};
    const unavailable = () => ({ status: 'unavailable', model: 'silero-vad', version: 'unknown', intervals: [],
        speechSeconds: 0, analyzedSeconds: 0, reason: 'Saved local speech analysis is unavailable or invalid.' });
    if (typeof data.model !== 'string' || typeof data.version !== 'string' ||
        !['complete', 'unavailable'].includes(data.status ?? '') || !Array.isArray(data.intervals) || data.intervals.length > 200_000 ||
        !Number.isFinite(data.analyzedSeconds) || !Number.isFinite(data.speechSeconds) || data.analyzedSeconds < 0 || data.speechSeconds < 0)
        return unavailable();
    if (data.status === 'unavailable')
        return { ...unavailable(), model: data.model, version: data.version,
            reason: 'Local speech analysis could not be completed.' };
    if (!Number.isFinite(duration) || duration <= 0 || Math.abs(data.analyzedSeconds - duration) > 0.25 ||
        data.intervals.some(r => !r || !Number.isFinite(r.start) || !Number.isFinite(r.end) || r.start < 0 || r.end <= r.start || r.end > data.analyzedSeconds + 0.001))
        return unavailable();
    const intervals = [];
    for (const range of [...data.intervals].sort((a, b) => a.start - b.start)) {
        const previous = intervals.at(-1);
        if (previous && range.start <= previous.end)
            previous.end = Math.max(previous.end, range.end);
        else
            intervals.push({ start: range.start, end: range.end });
    }
    return { status: 'complete', model: data.model, version: data.version, intervals, analyzedSeconds: data.analyzedSeconds,
        speechSeconds: intervals.reduce((sum, r) => sum + r.end - r.start, 0) };
}
/** Recompute from saved evidence; never claim the absence of detected speech is silence. */
export function refreshReview(job) {
    let missingTextCount = 0, shortTextCount = 0;
    job.speech = normalizeSpeech(job.speech, job.audio.duration);
    const analyzed = job.speech?.status === 'complete';
    for (const chunk of job.chunks) {
        delete chunk.review;
        if (!isChunkFinished(chunk))
            continue;
        // Migrate older manifests where HTTP success was treated as transcription success.
        if (chunk.status === 'complete')
            applyResponse(chunk, chunk.text === undefined ? {} : { text: chunk.text });
        else if (chunk.text !== undefined && typeof chunk.text !== 'string') {
            chunk.text = undefined;
            chunk.noTextReason = 'invalid_text';
        }
        const speechSeconds = analyzed ? speechInRange(job.speech.intervals, chunk.start, chunk.end) : undefined;
        const basis = analyzed ? 'speech' : 'duration';
        const wordCount = countWords(chunk.text ?? '');
        if (chunk.status === 'no_text') {
            chunk.review = { kind: 'missing_text', basis, wordCount, ...(speechSeconds === undefined ? {} : { speechSeconds }) };
            missingTextCount++;
            continue;
        }
        const duration = speechSeconds ?? Math.max(0, chunk.end - chunk.start);
        const minimum = analyzed ? REVIEW_RULES.minSpeechSeconds : REVIEW_RULES.minFallbackSeconds;
        const wordsPerMinute = duration > 0 ? wordCount * 60 / duration : undefined;
        if (duration >= minimum && wordsPerMinute !== undefined && wordsPerMinute < REVIEW_RULES.minWordsPerMinute) {
            chunk.review = { kind: 'short_text', basis, wordCount, wordsPerMinute, ...(speechSeconds === undefined ? {} : { speechSeconds }) };
            shortTextCount++;
        }
    }
    const analysisUnavailable = job.speech?.status === 'unavailable';
    const analysisNotRun = !job.speech && job.chunks.some(isChunkFinished);
    job.review = { needsReview: missingTextCount > 0 || shortTextCount > 0 || analysisUnavailable || analysisNotRun,
        missingTextCount, shortTextCount, analysisUnavailable, analysisNotRun };
}
export function formatTimestamp(seconds) {
    const milliseconds = Math.max(0, Math.round((Number.isFinite(seconds) ? seconds : 0) * 1000));
    const whole = Math.floor(milliseconds / 1000);
    const base = [Math.floor(whole / 3600), Math.floor(whole / 60) % 60, whole % 60].map(n => String(n).padStart(2, '0')).join(':');
    return milliseconds % 1000 ? `${base}.${String(milliseconds % 1000).padStart(3, '0')}` : base;
}
export function chunkAnnotation(job, chunk) {
    let message;
    if (chunk.status === 'no_text') {
        const reason = chunk.noTextReason === 'missing_text' ? 'Răspunsul nu conține câmpul text așteptat.'
            : chunk.noTextReason === 'invalid_text' ? 'Câmpul text din răspuns are un format neașteptat.'
                : 'Acest interval audio nu are text returnat.';
        message = `FĂRĂ TRANSCRIERE. ${reason} Verifică înregistrarea.`;
    }
    else if (chunk.status === 'failed')
        message = 'EROARE API / CERERE EȘUATĂ. Nu există un răspuns final pentru acest interval.';
    else if (chunk.status === 'interrupted')
        message = 'ÎNTRERUPT. Nu există un răspuns final confirmat pentru acest interval.';
    else if (chunk.status === 'pending')
        message = 'NEPROCESAT. Acest interval nu are încă un răspuns final.';
    else if (chunk.review?.kind === 'short_text')
        message = 'Transcriere posibil incompletă — verifică audio. Avertismentul privește întregul fragment; locul unei eventuale omisiuni nu este cunoscut.';
    if (!message)
        return;
    const name = job.filename.replace(/[\r\n\[\]]/g, ' ');
    return `[${name} | ${formatTimestamp(chunk.start)}–${formatTimestamp(chunk.end)} — ${message}]`;
}
export function assembleTranscript(job) {
    const parts = [...job.chunks].sort((a, b) => a.index - b.index).map(chunk => {
        const annotation = chunkAnnotation(job, chunk);
        // Whitespace-only text is retained in raw-transcript.txt and the raw JSON response.
        return [annotation, chunk.status === 'complete' ? chunk.text : undefined].filter(value => value !== undefined).join('\n');
    });
    if (job.review?.analysisUnavailable || job.review?.analysisNotRun) {
        parts.push(`[${job.filename.replace(/[\r\n\[\]]/g, ' ')} — VERIFICARE AUDIO INDISPONIBILĂ. ${job.review.analysisNotRun ? 'Detectarea locală a vorbirii nu a fost efectuată pentru această înregistrare.' : 'Detectarea locală a vorbirii nu a putut fi efectuată.'} Un rezultat nevid nu garantează transcrierea integrală.]`);
    }
    return parts.join('\n\n');
}
export function rawTranscript(job) {
    return [...job.chunks].sort((a, b) => a.index - b.index).filter(isChunkFinished).map(c => c.text ?? '').join('\n\n');
}
