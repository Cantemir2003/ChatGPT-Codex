# Bundled local speech detector

`silero_vad_v6.2.3.onnx` is the unmodified Silero VAD model from the official
[snakers4/silero-vad](https://github.com/snakers4/silero-vad) repository.

- Release: **v6.2.3**
- Pinned Git commit: `5cd7945676eb32225748052e2e6a0580e4686a08`
- [Exact download](https://raw.githubusercontent.com/snakers4/silero-vad/5cd7945676eb32225748052e2e6a0580e4686a08/src/silero_vad/data/silero_vad.onnx)
- SHA-256: `1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3`
- License: MIT, reproduced in [SILERO-LICENSE](SILERO-LICENSE).
- Downloaded and verified: 2026-10-15.

The application verifies the hash before loading the model. It never downloads a
model during use. ONNX Runtime Node **1.30.0** is pinned in the npm lockfile and
includes native CPU binaries for macOS ARM64. The local implementation follows
the upstream `OnnxWrapper`: 512 new samples, 64 context samples, recurrent state
`[2, 1, 128]`, and a scalar 16,000-Hz input. It uses the documented default
0.5 onset / 0.35 offset thresholds, 250-ms minimum speech, 100-ms minimum silence,
and 30-ms boundary padding. These are detection heuristics, not a guarantee that
all speech or every short utterance will be detected.

FFmpeg streams a separate mono 16-kHz float analysis view into the detector.
This view is never uploaded or written to disk. Source files and API-upload
sections are unchanged by speech analysis. The detector runs on the CPU with
one thread, no profiling, and no OpenAI calls. Audio and intervals stay local.

Before importing the native ONNX runtime, the application sets
`ORT_DISABLE_TELEMETRY=1`. This is the runtime's supported POSIX full opt-out:
[environment parser](https://github.com/microsoft/onnxruntime/blob/v1.30.0/onnxruntime/core/platform/telemetry_environment.h#L110)
and [initialization](https://github.com/microsoft/onnxruntime/blob/v1.30.0/onnxruntime/core/platform/posix/telemetry.cc#L437).
It prevents telemetry uploader creation, events, and device-ID persistence on
macOS and Linux. No runtime artifacts are written into the app directory.

For development on Linux x64, use `ONNXRUNTIME_NODE_INSTALL=skip npm ci` to skip
the package's optional CUDA download; its CPU binary is already bundled. macOS
ARM64 needs no extra runtime downloads or setup beyond the normal `npm ci`.

## Speech test fixture

`speech-fixture.wav` is the first eight seconds of upstream's
[`tests/data/test.wav`](https://raw.githubusercontent.com/snakers4/silero-vad/5cd7945676eb32225748052e2e6a0580e4686a08/tests/data/test.wav)
at the same pinned commit. It is distributed with the upstream repository's MIT
license above; no separate fixture license is supplied upstream. It is only used
in automated tests, never sent to OpenAI.

- Original SHA-256: `89f17d9c94c4b31eb320f424628bcbc920abaddbee6e2760fd868bfb1d9a2e47`
- Excerpt SHA-256: `426b819d09180d97fbb9910d5aaa400a0b399cd9c8afcb4ccc57dba70ac2cbfe`
- Excerpt command (FFmpeg 7.1.5): `ffmpeg -i test.wav -t 8 -c:a pcm_s16le speech-fixture.wav`
