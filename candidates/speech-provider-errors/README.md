# N02 structured speech-provider failures

This is an isolated, replayable source candidate for pinned rep12. It is not applied to the pinned SDK, an installed package, or product runtime.

## Contents

- `base/packages/...` are exact pre-edit source copies from pinned rep12.
- `after/packages/...` are the six changed source files. Replaying the candidate into a disposable copy means replacing only these same relative files with the matching `after` copies.
- [`SOURCE-SHA256.txt`](SOURCE-SHA256.txt) records pinned baseline, candidate base-copy, and candidate after hashes.
- [`../..` recovery evidence](../../recovery-20261029/n02-speech-provider-errors-20261031/VALIDATION.md) has exact overlay build/type-check/test commands and raw outputs.

## Changed package files

1. `packages/experimental/speech-to-text/src/types.ts`
2. `packages/experimental/speech-to-text/src/index.ts`
3. `packages/experimental/speech-to-text-sensevoice/src/runtime.ts`
4. `packages/experimental/speech-to-text-sensevoice/src/recognizer.ts`
5. `packages/experimental/api-speech-to-text/src/types.ts`
6. `packages/experimental/api-speech-to-text/src/index.ts`

The patch adds a formal `SpeechProviderFailure` with only `model-unavailable` and `worker-exited` facts, an optional exact-instance descriptor, SenseVoice reporting from checked runtime/actual `SubprocessHandle.done`, and optional typed API details while retaining legacy `reason`. A fetch transport rejection waits for an actual natural handle outcome only within the existing inference deadline; HTTP responses such as 500 remain ordinary failures, and cancellation/disposal remains nonfailure.

Treat all six files as one compatible batch across the three SDK packages and build them together. In particular, do not pair the new API or SenseVoice package with an old core: the typed descriptor is authenticated by the new core failure class identity. The normal backend consumer remains compatible with unpatched rep12, but without that descriptor it maps failures only to the generic `session_transcription_failed` code.

The temporary validation overlay contains only test wiring: dependency junctions to the pinned SDK packages, local `tsdown` configs, and a core `./wave` export path pointing at its generated test build. Those overlay metadata/config files are not part of the six-file candidate.
