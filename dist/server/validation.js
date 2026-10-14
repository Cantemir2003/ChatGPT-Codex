export class AppError extends Error {
    statusCode;
    constructor(message, statusCode = 400) {
        super(message);
        this.statusCode = statusCode;
    }
}
const object = (v) => { if (!v || typeof v !== 'object' || Array.isArray(v))
    throw new AppError('Please check the settings and try again.'); return v; };
const ISO_CODES = new Set('aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu'.split(' '));
export function validateTranscription(value) {
    const v = object(value);
    if (!Array.isArray(v.languages) || v.languages.some(x => typeof x !== 'string' || !ISO_CODES.has(x)))
        throw new AppError('Expected languages must be two-letter ISO language codes, such as ro or en.');
    if (typeof v.prompt !== 'string' || v.prompt.length > 12000)
        throw new AppError('Recording context must be text, up to the app’s 12,000-character safeguard. The API may have a smaller limit; keep context brief.');
    if (!Array.isArray(v.keywords) || v.keywords.some(x => typeof x !== 'string' || !x.trim() || /[<>\r\n]/.test(x)))
        throw new AppError('Each vocabulary term must be a nonempty single line without < or >.');
    if (typeof v.stream !== 'boolean')
        throw new AppError('Stream text must be on or off.');
    if (JSON.stringify(v).length > 64000)
        throw new AppError('Settings are too large for this app. Shorten the context or vocabulary.');
    return { languages: [...new Set(v.languages)], prompt: v.prompt, keywords: [...v.keywords], stream: v.stream };
}
export function validateApp(value) {
    const v = object(value);
    if (!['system', 'light', 'dark'].includes(String(v.theme)))
        throw new AppError('Choose System, Light, or Dark appearance.');
    if (typeof v.fontSize !== 'number' || v.fontSize < 14 || v.fontSize > 26)
        throw new AppError('Font size must be from 14 to 26.');
    if (typeof v.chunkMinutes !== 'number' || v.chunkMinutes < 1 || v.chunkMinutes > 10)
        throw new AppError('Choose a section duration from 1 to 10 minutes.');
    if (!Number.isInteger(v.retries) || Number(v.retries) < 0 || Number(v.retries) > 5)
        throw new AppError('Retry limit must be from 0 to 5.');
    if (typeof v.keepAudio !== 'boolean')
        throw new AppError('Keep audio must be on or off.');
    return { theme: v.theme, fontSize: v.fontSize, chunkMinutes: v.chunkMinutes, retries: v.retries, keepAudio: v.keepAudio };
}
export function validatePreferences(value) {
    const v = object(value);
    if (!Array.isArray(v.presets) || v.presets.length > 50)
        throw new AppError('You can save up to 50 presets.');
    const presets = v.presets.map(p => { const x = object(p); if (typeof x.name !== 'string' || !x.name.trim() || x.name.length > 80)
        throw new AppError('Preset names must contain 1–80 characters.'); return { name: x.name.trim(), settings: validateTranscription(x.settings) }; });
    if (new Set(presets.map(x => x.name)).size !== presets.length)
        throw new AppError('Choose a different name for each preset.');
    return { transcription: validateTranscription(v.transcription), app: validateApp(v.app), presets };
}
