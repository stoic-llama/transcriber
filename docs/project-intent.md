# Project intent

Sources: the initial MVP brief given to the implementing agent (not stored in the repo), and the implemented behaviour described in the README. Anything not traceable to those is marked as such.

## Purpose

A static web app that transcribes long local audio and video recordings, using the user's own OpenAI API key, with all processing in the user's browser.

## User problem

Someone has a long recording (a lecture or meeting, around two hours or more) and wants a text transcript. They don't want to upload the file to a third-party service, run software locally, or lose progress when something fails partway through a long job.

## Current MVP requirements

The user can:

1. Enter their own OpenAI API key.
2. Select a local audio or video file (MP3, MP4, M4A, WAV, WebM and anything else ffmpeg.wasm can decode).
3. Have the file processed locally. Only extracted audio chunks leave the browser, and they go straight to OpenAI's transcription API.
4. Transcribe recordings of around two hours or longer, split into chunks that fit the API's upload limit.
5. See progress, pause or cancel, and retry failed chunks individually.
6. Survive failures (network, API errors, tab close or refresh) and resume without re-transcribing completed chunks.
7. Download the finished transcript as a `.txt` named after the source file.

## Constraints

- **No application backend.** No server, API proxy, database, server-side storage or processing. The app must deploy as static files, including under a sub-path such as GitHub Pages' `/project/`.
- **The API key belongs to the user.** It is never hard-coded, committed, logged, fully displayed or sent anywhere except `api.openai.com`. It is kept in memory by default; saving it is explicit and optional.
- **Privacy.** No analytics, tracking or telemetry.
- **Memory.** A multi-GB, multi-hour file must never be loaded into memory whole. Process one chunk at a time.
- **Durability.** Progress is saved after every chunk, not at the end.
- **Scope.** Desktop browsers first. Plain UI; correctness over styling.
- **Honest tests.** Automated tests mock OpenAI and never make real API calls.

## Explicit non-goals (MVP)

Authentication, user accounts, payments, analytics, a database server, any backend or serverless functions, cloud storage, Docker or Kubernetes, parallel transcription, and showing timestamps in the UI.

## Future direction (not implemented)

Supported by existing code or the brief. None of it is a current requirement.

- **More providers**, such as local Whisper on WebGPU or open-weight models. The `TranscriptionProvider` interface exists so these can be added.
- **SRT/VTT/timestamped TXT export.** Chunks already store segments on the source timeline (`Chunk.segments`).
- **Speaker labels.** `TranscriptSegment.speaker` is reserved but unused.
- **Limited parallel transcription.** The queue keeps the per-chunk logic separate from its loop so a pool could be added later.
