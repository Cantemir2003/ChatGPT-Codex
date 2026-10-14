export const MODEL = 'gpt-transcribe';
export const PRICING = { usdPerMinute: 0.0045, verifiedOn: '2026-10-14', source: 'https://developers.openai.com/api/docs/pricing' };
export const MAX_CHUNK_BYTES = 24_000_000;
export const DEFAULTS = {
    transcription: { languages: ['ro'], prompt: 'Curs universitar de medicină dentară, predat în limba română.', keywords: [], stream: true },
    app: { theme: 'system', fontSize: 18, chunkMinutes: 5, retries: 2, keepAudio: false }, presets: []
};
export const estimateCost = (seconds) => seconds / 60 * PRICING.usdPerMinute;
