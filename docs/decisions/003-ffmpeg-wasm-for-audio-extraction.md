# Decision: ffmpeg.wasm (single-threaded, WORKERFS) for audio extraction
Status: Accepted
Date: 2026-09-26 (initial commit 3997f5d)

## Context
Recordings can be 2+ hours and more than 1 GB, in many containers (MP4, M4A, WebM, WAV, MP3…). The API needs compact audio chunks. The brief asked for browser-native APIs to be checked first and FFmpeg added only if needed, and required avoiding loading whole files into memory.

## Decision
Use `@ffmpeg/ffmpeg` with the single-threaded core. The user's `File` is mounted through the **WORKERFS** filesystem, so ffmpeg reads it lazily with random-access slices instead of copying it. Each operation (probe, silence detection, chunk encode) is a separate `ffmpeg` command that seeks with input `-ss`. It all lives in `src/media/audioExtractor.ts` behind the `AudioSource` interface (`src/types/media.ts`).

## Alternatives considered
Recorded in the header comment of `audioExtractor.ts`:
- **`AudioContext.decodeAudioData`:** needs the whole file in one `ArrayBuffer` and decodes it all to PCM (>1 GB for 2 h). It can't decode a range.
- **`MediaRecorder` on a playing media element:** works only in real time.
- **WebCodecs `AudioDecoder`:** needs a separate demuxer per container, and there's no MP3 encoder.
- **The multi-threaded ffmpeg core:** needs `SharedArrayBuffer`, which requires COOP/COEP headers that GitHub Pages can't set.

## Consequences
- One code path handles every container ffmpeg understands. Memory stays around chunk size. Seeking makes both planning and resume cheap.
- A ~32 MB core download on first use, which affects hosting (see 008).
- **ffmpeg.wasm is not re-entrant.** All calls go through one module-level `serialize()` queue, so ffmpeg work is sequential no matter how the caller is structured. Inside `serialize`, call the inner `run()` directly: a nested `serialize` deadlocks.
- An exception from ffmpeg (worker crash, out of memory) resets the instance, and the next command reloads and remounts it.
- Files larger than about 2 GB haven't been tested against the 32-bit WASM filesystem layer.

## Revisit when
- Files above ~2 GB fail in practice.
- Native browser APIs can demux and encode common containers (for example WebCodecs plus a native demuxer).
- The app moves to a host that can send COOP/COEP headers and more speed is needed (the multi-threaded core).
