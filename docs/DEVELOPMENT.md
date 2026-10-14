# Development notes

## Model contract, checked 14 October 2026

The only model used is `gpt-transcribe`, on `POST /v1/audio/transcriptions`, through the official OpenAI Node SDK. Model access failures remain visible errors. Generic Audio endpoint fields and shared SDK types are not evidence of support for this specific model.

Sources: [M: model](https://developers.openai.com/api/docs/models/gpt-transcribe), [G: file guide](https://developers.openai.com/api/docs/guides/speech-to-text), [R: endpoint reference](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create), [C: migration examples](https://developers.openai.com/cookbook/examples/migrating_from_whisper_to_gpt_transcribe), [P: pricing](https://developers.openai.com/api/docs/pricing). All five were read before integration.

“Default” below means this application's default, not an undocumented service default.

| Request field | GPT-Transcribe support | Validation / decision | App default | Source |
| --- | --- | --- | --- | --- |
| `model` | Confirmed | Fixed identifier; no fallback model | `gpt-transcribe` | M, G, R, C |
| `file` | Confirmed | Inspect real media; upload a named audio file. Documented maximum 25 MB; app caps sections at 24,000,000 bytes | Selected recording / prepared section | G, R |
| `languages` | Confirmed | ISO-639-1 string array; omit for automatic detection | `["ro"]` | G, R, C |
| `prompt` | Confirmed | Recording context, preferably in the spoken language. Numeric model length limit is unpublished; app safeguard 12,000 characters, API may accept less | `Curs universitar de medicină dentară, predat în limba română.` | G, R, C |
| `keywords` | Confirmed | Array of literal terms; no `<`, `>`, CR, or LF inside an entry. Empty list omitted | Empty | G, R, C |
| `stream` | Confirmed | Boolean; SDK SSE events. Final response text is authoritative | `true` | M, G, C |
| `response_format` | JSON confirmed | Only `json` is used; export extracts `text` locally | `json` | G, C |
| `language` | Replaced for this model | Never send; use plural `languages` | Omitted | G, C |
| `temperature` | Model-specific support unverified | Generic reference advertises 0–1; not enough evidence for this model | Omitted, no UI control | R; absent in M/G/C model examples |
| `include` / `logprobs` | Not verified for this model | Reference restricts logprobs to GPT-4o transcription models | Omitted | R |
| `timestamp_granularities` | Other-model feature | Guide limits this field to Whisper | Omitted | G, R |
| `chunking_strategy` | Model-specific support unverified | Generic endpoint field; used in diarization examples. Local splitting is separate | Omitted | G, R |
| `known_speaker_names`, `known_speaker_references`, `diarized_json` | Diarization-model features | Outside this model's verified contract | Omitted | G, R |
| Other output formats, translation, max-output-token controls | Not verified for this model | No invented controls or second model | Omitted | M, G, R, C |

The guide lists MP3, MP4, MPEG, MPGA, M4A, WAV, and WebM; the endpoint additionally lists FLAC and OGG. The app's media inspection and preparation determine what is sent. The file type is not trusted from its extension. Standard Voice Memos M4A is the primary path.

No numeric GPT-Transcribe input-duration, output-token, context-window, prompt-length, keyword-count, or keyword-length maximum was located in those sources. A five-minute default target reduces long-request exposure but cannot guarantee an unpublished limit. Application validation limits are protective UI/resource bounds, not API claims: context ≤12,000 characters; serialized settings ≤64,000 characters; font 14–26 px; section target 1–10 minutes; 0–5 retries (default 2); at most 50 presets with 1–80 character names. Vocabulary entries must be nonempty; there is no invented API count limit. If the API rejects a documented field or a limit, stop and expose the problem; never silently truncate the prompt, transcript, or switch models. Temperature is deliberately excluded until official model-specific support is established.

Pricing is duration-based at **US$0.0045/minute**, verified against M and P. `shared/config.ts` is the single maintained source for its amount, date, and URL. The duration estimate excludes unknown server billing details; retry attempts and uncertain requests are tracked separately. No balance query is performed.

## Application behavior

React/TypeScript provides the local UI; Express/TypeScript owns files, FFmpeg, persistence, and the official SDK. The production app binds only `127.0.0.1:43187`. The backend serves the built UI. There is no hosted component, analytics, or external asset CDN.

Transcription settings and application preferences are distinct. Named presets cover transcription settings. Theme, font size, section duration, retries, and audio retention are local app choices. A job captures its settings so changes do not silently alter an interrupted job.

The pipeline inspects codecs with ffprobe. Small verified M4A/MP3/WAV recordings are copied directly; larger recordings decode once into sample-aligned PCM WAV files with their original channel count and sample rate. A separate silence-detection pass chooses boundaries. Integer PCM precision is retained; floating-point decoded audio becomes 32-bit integer PCM, without another lossy codec. Working PCM audio can use several gigabytes. The pipeline chooses consecutive section boundaries near pauses when possible, and checks each actual section size before requesting transcription. Sections do not overlap. Silence detection chooses boundaries without deleting speech or silence. Raw final responses and section order are saved; combined text preserves model text with only separators between sections. No text normalization, translation, deduplication, or second model is applied.

Jobs are processed sequentially. Transient connection/server/rate-limit failures get bounded retries with backoff; invalid credentials, unsupported requests, model access errors, and exhausted quota stop the job. Successful sections are persisted and skipped when resuming. An interrupted request has an uncertain billing outcome; it is not automatically claimed as free. Cancellation aborts active work and retains completed results. A restart requires explicit resume, preventing unrequested paid work.

Data is under `~/Library/Application Support/Lecture Transcriber` on macOS. Per-job manifests, text, and raw responses remain after completion. Temporary source copies and prepared sections are cleaned up on success unless retention is enabled. The source selected by the user is copied; it is never deleted or overwritten. Job removal only touches the app's owned directory.

## Key storage and localhost boundary

On macOS, `scripts/keychain.swift` uses Apple's Security framework. Setup compiles it into `bin/keychain-helper`. The helper passes key material through stdin/stdout pipes to the backend, never process arguments or a shell. Its stdout is consumed internally and not logged. The browser can save, replace, or remove a key and receive a configured/not-configured status; it cannot retrieve the key. No key is persisted in browser storage or manifests. Non-macOS production key storage is intentionally unavailable.

The server validates the Host/Origin boundary and requires its per-process CSRF token on mutating requests, including uploads and shutdown. There is no wildcard CORS. External pages cannot read the bootstrap token under the browser same-origin policy. This is a single-user localhost app, not an access-control boundary against malicious software already running as the same Mac user.

Paths for working files are server-generated. Uploaded filenames are display metadata and sanitized for download headers. ffmpeg/ffprobe and the Keychain helper use argument arrays without a shell. Browser audio preview uses the browser media element, without decoding the entire lecture in JavaScript.

## Running and maintaining

Use Node.js **24 LTS** and FFmpeg/ffprobe on your path. Dependencies are exactly pinned in `package.json` and `package-lock.json`.

```sh
npm ci
npm run typecheck
npm test
npm run build
npm start
```

Open `http://127.0.0.1:43187`. On macOS, first compile the helper with `xcrun swiftc scripts/keychain.swift -o bin/keychain-helper -framework Security` after creating `bin`. The first-time setup launcher does this for the user. `npm run dev` is a backend watch command; rebuild frontend assets after UI changes when using the production server.

The `.command` launchers set paths for both Apple Silicon and Intel Homebrew and Node's macOS installer. Start checks `/api/health` for the app ID, opens an existing instance, or launches the built backend detached. The exclusive server port resolves simultaneous launch attempts. Stop fetches `/api/bootstrap`, then requests CSRF-protected `/api/shutdown`; it does not send an unchecked signal to a stored PID. A successful start leaves no daily Terminal commands to type. Logs contain operational errors, not secrets or request bodies.

Before updating dependencies, stop the app, keep a backup of the data folder, then review release notes and rerun checks. Update the lockfile intentionally. Never add a real API key or lecture to fixtures. No live API request is part of normal build or test commands.

## Verification status

Checked on 14 October 2026 in Linux, Node.js 24.19.0:

- `npm run typecheck` and `npm run build`: passed.
- `npm test`: 81 tests passed across audio, recovery/queue, SDK, and HTTP/security suites.
- Actual two-hour synthetic PCM recording: 24 five-minute sections, complete 57,600,000-sample coverage, every section within 24,000,000 bytes, original preserved. AAC/ALAC and multichannel byte-boundary tests also passed.
- Mocked official-SDK requests: exact model and field names, multipart arrays, authoritative stream final events, missing-final failure, no automatic SDK retries.
- Recovery, partial errors, cancellation, bounded retries, storage failure without duplicate paid requests, UTF-8 text and filenames, damaged-path safeguards, CSRF/origin checks, and secret isolation passed.
- Production smoke: built assets, FFmpeg readiness, exclusive loopback port, duplicate-instance rejection, and graceful shutdown passed.
- Playwright with Chromium at 1280×800: import, measured estimate, explicit start, mocked transcription, refresh, search, presets, key save/removal, export, cleanup, light/dark preferences, and selected enabled-control/text contrast checks (≥4.5:1) passed. A 390px layout check passed. The actual interface screenshots were inspected.
- Shell/JavaScript launcher syntax checks passed. `npm audit` reported zero known vulnerabilities for the locked dependency graph at verification time.

To rerun browser checks, first run `npm run build`, then `npx playwright install chromium`, then `npm run test:ui`. An existing Chromium can be selected through `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`. The browser harness uses synthetic audio and an injected mock key store/transcriber; production has no demo-key or mock-transcription mode. With the app stopped, `npm run test:production` checks the built server using a temporary data directory. Neither command performs a live transcription. The automated suite uses generated audio and mocked API responses. A real paid transcription was **not** tested because no user-selected sample and credentials were provided.

macOS Keychain compilation/permissions, Finder double-click behavior, Safari, Mac sleep/wake, and M3 hardware performance are **not verified in this environment**. The launchers have shell/JavaScript syntax checks; these do not establish macOS compatibility. On a Mac, first run a short recording you selected, inspect its returned text, verify resume and TXT export, and check your API usage before sending a full lecture.
