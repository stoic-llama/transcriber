# Local Transcriber

A static web app that transcribes long audio and video recordings (2 hours and more) **in your browser**, using **your own OpenAI API key**.

- No backend, no database, no accounts, no analytics. It deploys as plain static files (GitHub Pages, Cloudflare Pages, any static host).
- Your media file never leaves your computer. The browser extracts compact audio chunks from it and sends them **directly to `api.openai.com`**.
- Progress is saved to IndexedDB after every chunk. If the tab crashes, is closed or reloads, you can resume and completed chunks are **not** transcribed again.
- When it finishes, you download a `.txt` transcript named after the source file (`lecture.mp4` → `lecture.txt`).

```
Static website ─► User's browser
                   ├── local audio/video File (read in place, never uploaded)
                   ├── user's OpenAI API key (memory by default)
                   ├── ffmpeg.wasm: seek + encode one chunk at a time
                   ├── IndexedDB: job, chunk plan, per-chunk transcripts
                   ├── fetch ─► https://api.openai.com/v1/audio/transcriptions
                   └── transcript assembly ─► Download .txt
```

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/
npm run preview    # serve dist/ locally
```

Other scripts:

| Script | What it does |
| --- | --- |
| `npm test` | Unit tests (Vitest; OpenAI and ffmpeg are mocked, no network) |
| `npm run lint` / `npm run typecheck` | ESLint / TypeScript |
| `npm run vendor:ffmpeg` | Copy the ffmpeg.wasm core into `public/ffmpeg/` so you can self-host it |
| `npm run e2e` | Browser smoke test of the built site (see [Testing](#testing)) |

## Using it

1. Paste your OpenAI API key and press **Save key**. By default the key stays in memory and is forgotten when you reload. Tick **Remember on this device** only if you want it kept in `localStorage`. **Clear API key** removes it.
2. Pick an audio or video file (MP3, MP4, M4A, WAV, WebM, OGG, FLAC, MOV, MKV, …).
3. Press **Start transcription**. The app works out chunk boundaries, then transcribes chunk by chunk, showing progress and an estimate of the time left.
4. **Pause** finishes the chunk in progress and then stops. **Cancel** stops right away, and you choose whether to keep the job (so you can resume later) or delete it.
5. When it's done, press **Download TXT**.

**Resuming after a crash or reload:** reopen the page and you'll see *Incomplete transcription found* with **Resume** and **Delete job**. Press Resume and select the same file again. Browsers don't let a page reopen a local file by itself, so the app asks for it. The app checks that it's the same file, skips completed chunks, retries failed ones and carries on with pending ones. Selecting the same file from the normal picker also finds the unfinished job.

**Failed chunks:** each one is listed with a plain-language reason and its own **Retry** button.

## How it works, and the decisions behind it

### Audio extraction: ffmpeg.wasm (after ruling out native APIs)

| Option | Why it wasn't enough for 2-hour files |
| --- | --- |
| `AudioContext.decodeAudioData` | Needs the whole file in one `ArrayBuffer` and decodes all of it to PCM (>1 GB for 2 h). Can't decode a time range. |
| `MediaRecorder` on a playing `<video>` | Only runs in real time: 2 hours for a 2-hour file. |
| WebCodecs `AudioDecoder` | Needs a separate demuxer for each container, and has no MP3 encoder. |

[ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm) with the **WORKERFS** filesystem reads the user's `File` in place, through random-access slices, so nothing is copied into memory. It can seek straight to any timestamp and encode one chunk at a time:

```
seek to chunk start → encode 16 kHz mono MP3 → upload → save transcript → drop blob → next chunk
```

At most two chunk blobs are in memory at once (~3.6 MB each): the chunk being uploaded, and the next one, which is encoded while the current upload is in flight. The app uses the **single-threaded** core, which needs no `SharedArrayBuffer`. That means no COOP/COEP headers, which GitHub Pages can't set.

The ffmpeg core (`ffmpeg-core.wasm`) is ~32 MB and is fetched lazily the first time a file is processed. By default it comes from jsDelivr, because that file is bigger than Cloudflare Pages' 25 MiB per-file limit. To self-host it instead, run `npm run vendor:ffmpeg` and build with `VITE_FFMPEG_CORE_BASE_URL=./ffmpeg`. The GitHub Pages workflow does this.

### Chunk sizing

Limits used (from OpenAI's docs as of September 2026): uploads are capped at **25 MB**, and `gpt-4o-transcribe` / `gpt-4o-mini-transcribe` reject audio longer than **1500 s**.

Chunks are encoded as constant-bitrate MP3 (48 kbps, 16 kHz, mono; speech models downsample to 16 kHz anyway), so a chunk's size is predictable: `bytes ≈ seconds × 48000 / 8`. The maximum chunk length is the smallest of:

1. **Size:** `TARGET_CHUNK_BYTES` (20 MB, a safety margin under 25 MB) × 8 / bitrate ≈ 58 minutes
2. **Model limit**, with a 10% margin (1350 s for the gpt-4o models)
3. **Preferred maximum**, 10 minutes (`PREFERRED_MAX_CHUNK_SECONDS`), which limits how much work a failed request throws away

With the default encoding, (3) is the limit that applies, and chunks come out around 3.6 MB. If you raise the bitrate or switch to WAV, (1) takes over automatically. After encoding, the real size is checked again. A chunk over 25 MB is re-encoded at 24 kbps, and if it still doesn't fit, only that chunk fails. All of these values live in [`src/config.ts`](src/config.ts).

**Natural boundaries:** for each cut, ffmpeg's `silencedetect` scans the 30 s before the nominal boundary, and the cut moves to the middle of the longest pause in that window. Only those few seconds are decoded, so planning a 2-hour file takes seconds. If no pause is found, the cut stays where it was. The plan is saved with the job, so a resumed job uses exactly the same boundaries.

### OpenAI integration

- `POST https://api.openai.com/v1/audio/transcriptions` (multipart), sent straight from the browser with `Authorization: Bearer <key>`, `credentials: 'omit'` and no referrer.
- **Models** (September 2026): `gpt-transcribe` (the default; OpenAI's recommended file-transcription model, released July 2026), `gpt-4o-transcribe`, `gpt-4o-mini-transcribe` and `whisper-1`. You can also type in any other model ID. A job keeps the model it was started with.
- **Context between chunks:** for models that document the `prompt` parameter, the last ~600 characters of the previous chunk's transcript are sent as `prompt`, which helps with continuity and names. `gpt-transcribe` isn't sent a prompt until OpenAI confirms it supports one.
- **Timestamps:** `whisper-1` is asked for `verbose_json` segments. Other models return text only, and each chunk is stored as one segment covering its time range.
- **CORS:** OpenAI's API accepts cross-origin browser requests. This is the same mechanism the official SDK uses with `dangerouslyAllowBrowser`, so no proxy is needed and none exists. *(This build environment couldn't reach api.openai.com, so the browser tests mock the endpoint. Try one short file with your real key after deploying.)*

The provider sits behind a small interface ([`TranscriptionProvider`](src/transcription/TranscriptionProvider.ts)). A future local Whisper/WebGPU provider can replace [`OpenAITranscriptionProvider`](src/transcription/OpenAITranscriptionProvider.ts) without changing the chunking, storage or UI code.

### Persistence and resume

IndexedDB has two stores: `jobs` (metadata, settings and the file fingerprint) and `chunks` (one record per chunk: time range, status, attempts, transcript, segments, error). No media is ever stored. Each chunk's result is written as soon as it arrives. On startup, chunks left in `processing` (the tab died mid-request) go back to `pending`. **Delete job** removes the job and all of its chunk records in a single transaction.

**File identity:** a SHA-256 of size, `lastModified`, type, and three 1 MiB samples (start, middle, end). This reads at most 3 MiB, so it's instant even for multi-GB videos. The tradeoff: it wouldn't notice an edit that changes only unsampled bytes while keeping both size and modification time, which is an acceptable risk for resume matching. The file name isn't part of the fingerprint, so a renamed copy still matches.

### Failure handling

| Situation | Behaviour |
| --- | --- |
| Network error, timeout (5 min), HTTP 408/409/5xx, malformed response | Retried with exponential backoff and jitter (2 s → 60 s cap, 5 attempts). The UI shows what's happening. |
| HTTP 429 rate limit | "OpenAI rate limit reached. The application will retry automatically." Honours `Retry-After`. |
| 401 invalid key, 429 `insufficient_quota`, 403/404 no model access | Would affect every chunk, so the run **stops** after the first one with a clear message. Fix it, then press Resume. |
| 400/413 for one chunk, or a chunk that can't be decoded | That chunk is marked failed with the reason. The rest carry on, and you can retry it on its own. |
| Unsupported or corrupt file, or no audio track | "This browser could not process this media format. Try MP3, WAV, M4A, MP4, or WebM." |
| ffmpeg out of memory / worker crash | The worker is reset and the run stops with a message. Completed chunks are kept, so press Resume. |
| Tab closed or refreshed | Progress is already saved, and the page warns before closing mid-run. Resume skips completed chunks. |

The run processes **one chunk at a time**, which keeps rate limits, memory use, ordering and resume simple. The per-chunk logic (`processChunk` in [`transcriptionQueue.ts`](src/transcription/transcriptionQueue.ts)) is separate from the loop, so a small worker pool could be added later. The final transcript is always assembled by chunk index, never by completion order.

## Deploying

The build uses relative asset URLs (`base: './'`), so the same `dist/` works at the root of a domain or under a sub-path such as `https://username.github.io/transcriber/`.

### GitHub Pages

1. Push the repo to GitHub.
2. In **Settings → Pages**, set **Source** to **GitHub Actions**.
3. Push to `main`, or run the *Deploy to GitHub Pages* workflow by hand. [`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml) lints, tests, self-hosts ffmpeg.wasm and publishes `dist/`.

To do it by hand instead: `npm run vendor:ffmpeg && VITE_FFMPEG_CORE_BASE_URL=./ffmpeg npm run build`, then publish `dist/` (for example on a `gh-pages` branch).

### Cloudflare Pages

Connect the repo and set:

- Build command: `npm run build`
- Build output directory: `dist`
- Environment: `NODE_VERSION=22`

Leave `VITE_FFMPEG_CORE_BASE_URL` unset. ffmpeg's 32 MB wasm file is over Cloudflare Pages' 25 MiB per-file limit, so it loads from jsDelivr.

### Any other static host

Upload `dist/`. No server configuration, rewrites or special headers are needed.

## Testing

**Unit tests** (`npm test`, 66 tests) cover chunk ordering and transcript assembly, retry/backoff, resume (completed chunks skipped, failed ones retried, pending ones continued), per-chunk retry, pause and cancel, job persistence across reconnects, job deletion, crash recovery, mapping OpenAI errors to messages (401/403/404/413/429/quota/5xx/timeout/network/malformed), chunk planning and silence parsing, and fingerprinting. They use `fake-indexeddb` and mocked `fetch`, and make no real API calls.

**Browser smoke test** (`npm run e2e`) runs the built site in Chromium, served under `/transcriber/`. Real ffmpeg.wasm chunks a generated recording, and `api.openai.com` is intercepted and mocked (including a 429 and a 500). The test reloads the page mid-job, resumes, checks that completed chunks aren't sent again, downloads the TXT, checks chunk order and silence-aligned boundaries, checks that no request goes anywhere except the site and OpenAI, and checks that deleting the job empties IndexedDB.

```bash
npm run vendor:ffmpeg
VITE_FFMPEG_CORE_BASE_URL=./ffmpeg npm run build
npm run e2e                                # ~21-minute WAV
E2E_SECONDS=7380 npm run e2e               # ~2-hour WAV (236 MB, 13 chunks)
E2E_MEDIA=path/to/video.mp4 npm run e2e    # your own file
CHROMIUM_PATH=/path/to/chrome npm run e2e  # if Chromium isn't at /opt/pw-browsers/chromium
```

## Known limitations

- Resuming needs the original file to be selected again (a browser security rule).
- Built and tested for desktop Chromium-based browsers. Firefox and Safari should work, since everything used is standard, but they haven't been tested by the automated suite. Mobile isn't a target.
- Files larger than about 2 GB haven't been tested with ffmpeg.wasm's 32-bit filesystem layer.
- Keep the tab open while it runs. Background tabs keep going, but the OS may suspend a sleeping laptop, so the app asks for a screen wake lock where the browser supports it.

## Project layout

```
src/
  config.ts                  every tunable: limits, bitrates, retry policy, ffmpeg URL
  App.tsx, useTranscriber.ts UI state and orchestration
  settings.ts                API key (memory, or localStorage if opted in) and preferences
  components/                ApiKeyInput, ModelSettings, FilePicker, JobProgress, JobList, …
  media/                     ffmpeg.wasm source, probing, silence-aware chunk planner
  storage/                   IndexedDB (idb): jobs, chunks, crash recovery
  transcription/             provider interface, OpenAI provider, queue, transcript assembly
  types/                     job, chunk, transcript and media types
  utils/                     retry/backoff, file fingerprint, formatting
e2e/smoke.mjs                browser end-to-end test of the static build
```

## Future work (not implemented)

- SRT/VTT/timestamped TXT export (segments are already stored on the source timeline)
- Speaker labels (`TranscriptSegment.speaker` is reserved)
- More providers: local Whisper on WebGPU, other open-weight models
- Limited parallel transcription
