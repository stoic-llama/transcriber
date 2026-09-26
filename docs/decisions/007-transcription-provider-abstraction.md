# Decision: Provider interface, OpenAI implementation and error classes
Status: Accepted
Date: 2026-09-26 (initial commit 3997f5d)

## Context
The brief asked for the transcription provider to be modular so a local Whisper/WebGPU or other provider could replace OpenAI later, with only OpenAI implemented now. It also asked for the current recommended transcription model rather than a hard-coded older one, and for errors users can understand.

## Decision
- `TranscriptionProvider` (`src/transcription/TranscriptionProvider.ts`) has a single method, `transcribe(audio, options) → { text, segments?, language? }`. The queue depends only on this interface.
- `OpenAITranscriptionProvider` sends multipart requests to `/v1/audio/transcriptions`. Model capabilities live in `src/transcription/models.ts`:
  - The default is **`gpt-transcribe`**, which OpenAI recommended for file transcription when this was written (released July 2026).
  - `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, `whisper-1`, and any custom model ID are also allowed.
  - The previous chunk's transcript tail is sent as `prompt` only to models known to accept it. Whether `gpt-transcribe` accepts `prompt` was unknown, so it isn't sent.
  - Only `whisper-1` is asked for `verbose_json` segments.
- Failures become a `TranscriptionError` with a `kind`, a plain-language `userMessage`, and two flags:
  - `retryable` (network, timeout, 429 rate limit, 5xx, malformed response): retried with exponential backoff, honouring `Retry-After`. Defaults: 5 attempts, 2 s base, 60 s cap, 5 min request timeout.
  - `fatalForJob` (401 auth, 429 quota, 403/404 permission): stops the whole run after the first failure.
  - Anything else (400/413): fails that chunk only, and the run continues.

## Alternatives considered
None recorded beyond the brief's direction.

## Consequences
- A new provider needs an implementation plus a way to pick it in `useTranscriber.ts`, the only place a provider is constructed. `models.ts` is OpenAI-specific.
- Providers without timestamps give one segment per chunk, so future SRT/VTT export works only at chunk granularity for those models.
- API error text is kept in `error.message` for debugging, but only `userMessage` reaches the UI. The key never appears in either, and a test checks this.

## Revisit when
- A second provider is added. Then decide where model lists and capabilities should live.
- OpenAI documents `prompt` support or duration limits for `gpt-transcribe`, or changes its recommended model.
