/**
 * Central tunables. Everything that affects how audio is chunked or how the
 * OpenAI API is called lives here so the tradeoffs are documented in one place.
 */

const MB = 1024 * 1024;

/** OpenAI's documented upload limit for /v1/audio/transcriptions. */
export const API_MAX_UPLOAD_BYTES = 25 * MB;

/**
 * Safety margin: chunks are planned to stay under this size, leaving headroom
 * for container overhead, multipart encoding and bitrate variance.
 */
export const TARGET_CHUNK_BYTES = 20 * MB;

/**
 * Chunk encoding. Speech models work on 16 kHz mono internally, so anything
 * richer is wasted upload bandwidth. MP3 is universally accepted by the API and
 * constant-bitrate MP3 makes the output size predictable:
 *   bytes ≈ seconds × bitrate / 8
 */
export const CHUNK_SAMPLE_RATE = 16_000;
export const CHUNK_BITRATE_BPS = 48_000;
/** Used if a chunk unexpectedly comes out above the API limit. */
export const FALLBACK_BITRATE_BPS = 24_000;
export const CHUNK_MIME_TYPE = 'audio/mpeg';
export const CHUNK_EXTENSION = 'mp3';

/**
 * Upper bound on chunk duration regardless of size. Some OpenAI models reject
 * long inputs (gpt-4o-transcribe caps at 1500 s), and shorter chunks mean less
 * work is lost if a request fails. Model-specific limits in
 * `transcription/models.ts` can lower this further.
 */
export const PREFERRED_MAX_CHUNK_SECONDS = 10 * 60;

/**
 * Chunk boundaries are moved back to the nearest pause in speech found in the
 * last SILENCE_SEARCH_SECONDS before the nominal boundary.
 */
export const SILENCE_SEARCH_SECONDS = 30;
export const SILENCE_NOISE_DB = -35;
export const SILENCE_MIN_SECONDS = 0.35;

/** Retry policy for transient failures (network, 429, 5xx, timeouts). */
export const RETRY_MAX_ATTEMPTS = 5;
export const RETRY_BASE_DELAY_MS = 2_000;
export const RETRY_MAX_DELAY_MS = 60_000;

/** Abort an OpenAI request that has not answered within this time. */
export const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

/** Abort a single ffmpeg invocation that runs longer than this. */
export const FFMPEG_EXEC_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Where the ffmpeg.wasm core is loaded from. The core is ~32 MB, which exceeds
 * Cloudflare Pages' 25 MiB per-file limit, so the default is a public CDN.
 * `npm run vendor:ffmpeg` + VITE_FFMPEG_CORE_BASE_URL=./ffmpeg self-hosts it.
 */
export const FFMPEG_CORE_VERSION = '0.12.10';
export const FFMPEG_CORE_BASE_URL: string =
  import.meta.env.VITE_FFMPEG_CORE_BASE_URL ||
  `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${FFMPEG_CORE_VERSION}/dist/esm`;

/** Characters of the previous chunk's transcript passed as context `prompt`. */
export const CONTEXT_PROMPT_CHARS = 600;
