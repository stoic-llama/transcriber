# Architecture

This describes the system as it currently exists. The reasons behind these choices are in [`../decisions/`](../decisions/).

## Runtime and deployment model

- A single-page React 19 + TypeScript app built with Vite into static files (`dist/`). There is no server component.
- Everything runs in the user's browser tab. Audio processing runs in ffmpeg.wasm's Web Worker. The only other network traffic is the ffmpeg core download and requests to OpenAI.
- Built with a relative base (`base: './'` in `vite.config.ts`), so it works at a domain root or under a sub-path.
- Deployed to GitHub Pages by `.github/workflows/deploy-pages.yml` ([decision 008](../decisions/008-static-deployment-and-ffmpeg-core-hosting.md)).

## Major components

| Area | Files | Responsibility |
| --- | --- | --- |
| UI | `src/App.tsx`, `src/components/*` | Presentational components. They receive state and callbacks and don't touch storage, ffmpeg or the network. |
| Orchestration | `src/useTranscriber.ts` | The one React hook that holds UI state and wires concrete implementations together: file selection, job creation, running and pausing the queue, resume, download. The composition root. |
| Settings | `src/settings.ts` | API key (memory, or `localStorage` if opted in) and model/language preferences. |
| Job planning | `src/transcription/jobFactory.ts`, `src/media/audioChunker.ts` | Probe the media, compute max chunk length, plan silence-aligned cuts with overlapping chunks around them, persist job and chunks. |
| Queue | `src/transcription/transcriptionQueue.ts` | Process chunks in order: extract → transcribe with retries → save. Handles pause, cancel, and fatal vs per-chunk errors. |
| Provider | `src/transcription/TranscriptionProvider.ts`, `OpenAITranscriptionProvider.ts`, `models.ts` | Speech-to-text interface, the OpenAI implementation, and the known model list. |
| Media | `src/media/audioExtractor.ts`, `mediaInfo.ts`, `MediaError.ts` | `FfmpegAudioSource`: probe, silence detection, and chunk encoding using ffmpeg.wasm; native duration probe; media error types. |
| Storage | `src/storage/*` | IndexedDB access through `idb`: jobs, chunks, crash recovery. |
| Transcript | `src/transcription/transcript.ts` | Turn provider results into timeline segments, assemble the transcript by chunk order, removing words repeated in the overlap between neighbouring chunks. |
| Shared | `src/config.ts`, `src/types/*`, `src/utils/*` | Tunables, domain types, retry/backoff, file fingerprint, formatting. |

## Primary data flow

```
User picks a File (FilePicker)
  │
  ▼
useTranscriber.selectFile
  ├─ fingerprintFile: SHA-256 of metadata + three 1 MiB samples
  ├─ probeNativeDuration: <audio>/<video> metadata only
  └─ findJobsByFingerprint (IndexedDB) ──► unfinished job? offer Resume
  │
  ▼  "Start transcription"
jobFactory.createJob
  ├─ FfmpegAudioSource.probe: ffmpeg reads the File in place (WORKERFS)
  ├─ maxChunkSeconds: min(size target, model limit, preferred max)
  ├─ planChunks: silencedetect in the 30 s before each nominal cut;
  │    chunks overlap by 4 s around every cut (decision 009)
  └─ saveChunks + saveJob (IndexedDB, status "pending")
  │
  ▼
TranscriptionQueue.run: chunks in id order, completed chunks skipped
  ┌──────────────────────────────── for each chunk ───────────────────────────────┐
  │ updateChunk "processing" (IndexedDB)                                          │
  │ FfmpegAudioSource.extract → 16 kHz mono CBR MP3 Blob (next chunk prefetched)  │
  │ retryWithBackoff(OpenAITranscriptionProvider.transcribe)                      │
  │        ── multipart HTTPS, Bearer key ──►  api.openai.com/v1/audio/transcriptions │
  │ updateChunk "completed" + transcript + segments (IndexedDB)                   │
  │ QueueEvent ──► React state (progress, ETA, notices)                           │
  └───────────────────────────────────────────────────────────────────────────────┘
  │
  ▼
all chunks completed ──► job "completed" (IndexedDB)
  │
  ▼  "Download TXT"
getChunks ──► assembleTranscriptText (sorted by chunk id, overlap repeats removed) ──► Blob ──► "<source name>.txt"
```

**Resume path:** on page load, `recoverInterruptedJobs` turns `processing` chunks back into `pending` and `transcribing` jobs into `paused`. Resume needs the File again, because browsers won't let a page reopen one itself. `useTranscriber` sets `needsFileFor`, the picker opens, and the fingerprint must match. Then `TranscriptionQueue.run` continues with the remaining chunks. "Retry" on one chunk calls `run({ onlyChunkIds: [id] })`.

## State and persistence

| Where | What | Lifetime |
| --- | --- | --- |
| IndexedDB `local-transcriber`, store `jobs` | Job metadata, settings, fingerprint, status, last job-level error. Indexed by fingerprint. | Until the user deletes the job |
| IndexedDB `local-transcriber`, store `chunks` (key `[jobId, id]`) | Chunk time range, status, attempts, transcript, segments, error | Deleted with its job, in the same transaction |
| `localStorage` `transcriber.openaiApiKey` | API key, only if "Remember on this device" is ticked | Until "Clear API key" |
| `localStorage` `transcriber.prefs` | Model and language preference | Persistent |
| React state in `useTranscriber` | Active job, chunk list, phase, progress, errors | The tab |
| Module state in `audioExtractor.ts` | The single ffmpeg instance and its command queue | The tab |

No media (the original file or encoded chunks) is ever persisted. Chunk blobs exist in memory only while they are being processed.

**Job status:** `pending` → `transcribing` → one of `completed`, `paused` or `failed`. Paused and failed jobs can be resumed. `planning` exists in the `JobStatus` type but is never persisted, because jobs are saved only after planning finishes.

**Chunk status:** `pending` → `processing` → `completed` or `failed`. `processing` only lasts as long as a live queue.

## External dependencies and services

- **OpenAI Audio Transcriptions API** (`https://api.openai.com/v1/audio/transcriptions`). Only called from `OpenAITranscriptionProvider`.
- **ffmpeg.wasm core** (`ffmpeg-core.js` and `.wasm`, ~32 MB). Fetched by `audioExtractor.ts` from `FFMPEG_CORE_BASE_URL`: jsDelivr by default, or same-origin `./ffmpeg` when self-hosted.
- **Runtime npm dependencies:** `react`, `react-dom`, `idb`, `@ffmpeg/ffmpeg`, `@ffmpeg/util`. `@ffmpeg/core` is a dev dependency, used only by `scripts/vendor-ffmpeg.mjs` for self-hosting.

## Architectural boundaries

These can be checked from the import graph:

- **Only `useTranscriber.ts` constructs concrete implementations** (`FfmpegAudioSource`, `OpenAITranscriptionProvider`). The queue depends only on the `TranscriptionProvider` and `AudioSource` interfaces, which is what lets tests use fakes and what would let another provider slot in.
- **Only `src/media/audioExtractor.ts` imports `@ffmpeg/*`.** Only `src/storage/db.ts` imports `idb`. Only `src/settings.ts` touches `localStorage`.
- **The network is limited to** `OpenAITranscriptionProvider` (OpenAI) and `audioExtractor.ts` (fetching the ffmpeg core). Adding any other network destination breaks the privacy constraint.
- **Components are presentational.** Apart from types and the `MODELS` list, they don't import storage, media or transcription modules.
- **Not a boundary:** storage is *not* behind an interface. `transcriptionQueue.ts` and `jobFactory.ts` call `src/storage/*` directly, and tests use `fake-indexeddb` rather than injected fakes.

## Constraints to respect when changing things

- **ffmpeg.wasm is not re-entrant.** Every ffmpeg call goes through the module-level `serialize()` queue in `audioExtractor.ts`. Code already running inside `serialize` must call the inner `run()` directly, because a nested `serialize` deadlocks. Adding "concurrency" does not parallelise ffmpeg work.
- **Promises created ahead of time need a rejection handler.** The queue creates the audio promise (and the next chunk's prefetch) before awaiting it, so each one gets a no-op `.catch` and is awaited later where the error is reported. Without it, an extraction failure becomes an unhandled rejection. The unit test suite caught exactly this.
- **Assemble transcripts by chunk `id`, never by completion order** (`orderedChunks`).
- **Never trust silence detection to keep words whole.** It can find no pause (noisy audio, continuous speech) or misplace one, and a word cut in two is lost by both chunks. Chunks overlap around every cut, so any word shorter than the overlap is whole in some chunk ([009](../decisions/009-overlapping-chunks.md)). When changing chunking or the transcript merge, keep `src/media/silenceChunking.test.ts` green. When in doubt, the merge must keep a duplicate rather than drop a word.
- **Errors that affect every chunk stop the run** (`isFatalForJob` in the queue: invalid key, no quota, no model access, any `MediaError` other than `unsupported`, and unknown errors). Don't let them mark each remaining chunk failed.

## Tests

- Unit tests sit next to the code (`src/**/*.test.ts`, Vitest, Node environment). `src/test/setup.ts` gives each test a fresh `fake-indexeddb`. `src/test/fakes.ts` provides `FakeAudioSource`, `FakeProvider` and `seedJob`. OpenAI is mocked by injecting `fetch`.
- `src/media/silenceChunking.test.ts` is the word-loss suite. It uses spoken WAV fixtures with hand-written ground truth in `tests/fixtures/silence/` (generated offline by `scripts/generate-silence-fixtures.mjs`), a port of ffmpeg's `silencedetect`, and an offline stand-in recogniser (`src/test/silenceFixtures.ts`). It checks chunk geometry and end-to-end word survival for named scenarios, sweeps of cut positions, and deliberately wrong silence detections, and prints a WER / deletion / insertion report.
- `e2e/smoke.mjs` drives the built site in Chromium, served under `/transcriber/`, with real ffmpeg.wasm and `api.openai.com` intercepted by Playwright. See the README for how to run it.

## Areas that may deserve deeper docs later

Not written yet because the code comments currently cover them. Write them if these areas grow:

- The queue and resume state machine (job and chunk transitions, pause, cancel and prefetch interactions).
- The media pipeline (ffmpeg command lines, seeking, silence detection, memory behaviour with very large files).
- The error taxonomy (the full mapping from HTTP and media failures to retryable, per-chunk or fatal-for-job, and the messages shown).
