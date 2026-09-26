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

## How it works

Architecture, data flow and module boundaries: [`docs/architecture/index.md`](docs/architecture/index.md). The reasoning behind the main choices is in [`docs/decisions/`](docs/decisions/): why ffmpeg.wasm, how chunks are sized, how resume works, how errors are handled. Tunables such as limits, bitrates and the retry policy live in [`src/config.ts`](src/config.ts). If you're an AI agent or a new contributor, start with [`AGENTS.md`](AGENTS.md).

**What happens when things go wrong:**
- Temporary problems (network, rate limits, OpenAI outages, timeouts) are retried automatically.
- A rejected key or an account out of credits stops the run with a message. Fix it, then press Resume.
- A chunk OpenAI can't process is marked failed, and you can retry it on its own.
- Closing or reloading the tab loses nothing that was already saved.

## Deploying

The build uses relative asset URLs (`base: './'`), so the same `dist/` works at the root of a domain or under a sub-path such as `https://username.github.io/transcriber/`.

### GitHub Pages

1. Push the repo to GitHub.
2. In **Settings → Pages**, set **Source** to **GitHub Actions**.
3. Push to `main`, or run the *Deploy to GitHub Pages* workflow by hand. [`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml) lints, tests, self-hosts ffmpeg.wasm and publishes `dist/`.

If the site is blank or the deploy job is rejected, see the two lessons in [decision 008](docs/decisions/008-static-deployment-and-ffmpeg-core-hosting.md#consequences): Source must be "GitHub Actions", and the `github-pages` environment must allow `main`.

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

**Unit tests** (`npm test`) cover chunk ordering and transcript assembly, retry/backoff, resume (completed chunks skipped, failed ones retried, pending ones continued), per-chunk retry, pause and cancel, job persistence across reconnects, job deletion, crash recovery, mapping OpenAI errors to messages (401/403/404/413/429/quota/5xx/timeout/network/malformed), chunk planning and silence parsing, and fingerprinting. They use `fake-indexeddb` and mocked `fetch`, and make no real API calls.

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

Planned but not implemented: see [`docs/project-intent.md`](docs/project-intent.md#future-direction-not-implemented).
