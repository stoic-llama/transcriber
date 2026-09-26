import { FFmpeg, FFFSType } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';
import {
  CHUNK_BITRATE_BPS,
  CHUNK_MIME_TYPE,
  CHUNK_SAMPLE_RATE,
  FFMPEG_CORE_BASE_URL,
  FFMPEG_EXEC_TIMEOUT_MS,
  SILENCE_MIN_SECONDS,
  SILENCE_NOISE_DB,
} from '../config';
import type { AudioSource, MediaProbe, SilenceInterval } from '../types/media';
import { MediaError, looksLikeOutOfMemory } from './MediaError';
import { parseFfmpegProbe, parseSilenceLog } from './mediaInfo';

/**
 * Why ffmpeg.wasm?
 * ----------------
 * Browser-native options were evaluated first:
 * - `AudioContext.decodeAudioData` needs the whole file in one ArrayBuffer and
 *   produces uncompressed PCM for all of it (a 2-hour recording is >1 GB even
 *   at 16 kHz), and cannot decode a range.
 * - `MediaRecorder` on a playing <video> works only in real time (2 hours for a
 *   2-hour file).
 * - WebCodecs `AudioDecoder` needs a separate demuxer per container format and
 *   still has no MP3 encoder.
 * ffmpeg.wasm with the WORKERFS filesystem reads the user's File lazily
 * (random-access slices, nothing copied into memory), seeks to any timestamp,
 * and encodes compact MP3 — one chunk at a time. We use the single-threaded
 * core because it needs no SharedArrayBuffer, i.e. no COOP/COEP headers, which
 * GitHub Pages cannot set.
 */

const INPUT_DIR = '/input';

let ffmpegInstance: FFmpeg | null = null;
let loadPromise: Promise<FFmpeg> | null = null;
/** ffmpeg.wasm is not re-entrant: run one command at a time. */
let queue: Promise<unknown> = Promise.resolve();
let currentLog: string[] | null = null;

async function loadFfmpeg(): Promise<FFmpeg> {
  if (ffmpegInstance?.loaded) return ffmpegInstance;
  if (!loadPromise) {
    loadPromise = (async () => {
      const ffmpeg = new FFmpeg();
      ffmpeg.on('log', ({ message }) => currentLog?.push(message));
      const base = new URL(FFMPEG_CORE_BASE_URL.replace(/\/$/, '') + '/', document.baseURI).href;
      try {
        await ffmpeg.load({
          coreURL: await toBlobURL(`${base}ffmpeg-core.js`, 'text/javascript'),
          wasmURL: await toBlobURL(`${base}ffmpeg-core.wasm`, 'application/wasm'),
        });
      } catch (error) {
        ffmpeg.terminate();
        throw new MediaError('load_failed', String(error), { cause: error });
      }
      ffmpegInstance = ffmpeg;
      return ffmpeg;
    })().finally(() => {
      loadPromise = null;
    });
  }
  return loadPromise;
}

/** Drops the worker (e.g. after an out-of-memory crash) so the next call starts fresh. */
function resetFfmpeg(): void {
  try {
    ffmpegInstance?.terminate();
  } catch {
    // already dead
  }
  ffmpegInstance = null;
}

function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

function secondsArg(value: number): string {
  return Math.max(0, value).toFixed(3);
}

function safeExtension(name: string): string {
  const match = /\.([a-z0-9]{1,5})$/i.exec(name);
  return match ? `.${match[1].toLowerCase()}` : '';
}

let outputCounter = 0;

/**
 * An AudioSource backed by ffmpeg.wasm reading the user's File in place.
 * Only one source is mounted at a time.
 */
export class FfmpegAudioSource implements AudioSource {
  private readonly file: File;
  private readonly inputName: string;
  private mountedOn: FFmpeg | null = null;

  constructor(file: File) {
    this.file = file;
    // WORKERFS exposes the blob under this name; avoid odd characters in paths.
    this.inputName = `media${safeExtension(file.name)}`;
  }

  private get inputPath(): string {
    return `${INPUT_DIR}/${this.inputName}`;
  }

  private async ready(): Promise<FFmpeg> {
    const ffmpeg = await loadFfmpeg();
    if (this.mountedOn !== ffmpeg) {
      try {
        await ffmpeg.createDir(INPUT_DIR);
      } catch {
        // exists
      }
      try {
        await ffmpeg.unmount(INPUT_DIR);
      } catch {
        // nothing mounted
      }
      await ffmpeg.mount(FFFSType.WORKERFS, { blobs: [{ name: this.inputName, data: this.file }] }, INPUT_DIR);
      this.mountedOn = ffmpeg;
    }
    return ffmpeg;
  }

  /**
   * Runs one ffmpeg command on an already-locked instance. Callers must be
   * inside `serialize`. A thrown error (worker crash, OOM) resets ffmpeg so the
   * next command reloads it.
   */
  private async run(ffmpeg: FFmpeg, args: string[]): Promise<{ code: number; log: string }> {
    const log: string[] = [];
    currentLog = log;
    try {
      const code = await ffmpeg.exec(['-hide_banner', '-nostdin', '-nostats', ...args], FFMPEG_EXEC_TIMEOUT_MS);
      return { code, log: log.join('\n') };
    } catch (error) {
      resetFfmpeg();
      this.mountedOn = null;
      if (looksLikeOutOfMemory(error) || looksLikeOutOfMemory(log.join('\n'))) {
        throw new MediaError('memory', String(error), { cause: error });
      }
      throw error;
    } finally {
      currentLog = null;
    }
  }

  private exec(args: string[]): Promise<{ code: number; log: string }> {
    return serialize(async () => this.run(await this.ready(), args));
  }

  async probe(): Promise<MediaProbe> {
    // With no output file ffmpeg exits non-zero, but still prints stream info.
    const { log } = await this.exec(['-i', this.inputPath]);
    if (/NotReadableError|Permission denied|could not be read/i.test(log)) {
      throw new MediaError('file_unreadable');
    }
    const probe = parseFfmpegProbe(log);
    if (/Invalid data found when processing input/i.test(log) || (!probe.hasAudio && !Number.isFinite(probe.duration))) {
      throw new MediaError('unsupported', lastLines(log));
    }
    if (!probe.hasAudio) throw new MediaError('no_audio');
    return probe;
  }

  async findSilences(start: number, end: number): Promise<SilenceInterval[]> {
    const duration = end - start;
    const { log } = await this.exec([
      '-ss', secondsArg(start),
      '-t', secondsArg(duration),
      '-i', this.inputPath,
      '-map', '0:a:0',
      '-af', `silencedetect=noise=${SILENCE_NOISE_DB}dB:d=${SILENCE_MIN_SECONDS}`,
      '-f', 'null', '-',
    ]);
    // Input seeking resets timestamps to 0, so results are window-relative.
    return parseSilenceLog(log, duration).map((s) => ({ start: start + s.start, end: start + s.end }));
  }

  async extract(start: number, end: number, options: { bitrate?: number } = {}): Promise<Blob> {
    const bitrate = options.bitrate ?? CHUNK_BITRATE_BPS;
    const output = `/chunk-${++outputCounter}.mp3`;
    return serialize(async () => {
      const ffmpeg = await this.ready();
      try {
        const { code, log } = await this.run(ffmpeg, [
          '-ss', secondsArg(start),
          '-t', secondsArg(end - start),
          '-i', this.inputPath,
          '-map', '0:a:0',
          '-vn', '-sn', '-dn',
          '-ac', '1',
          '-ar', String(CHUNK_SAMPLE_RATE),
          '-c:a', 'libmp3lame',
          '-b:a', `${Math.round(bitrate / 1000)}k`,
          '-y', output,
        ]);
        if (code !== 0) throw new MediaError('unsupported', `ffmpeg exited with ${code}: ${lastLines(log)}`);
        const data = await ffmpeg.readFile(output);
        if (typeof data === 'string' || data.byteLength === 0) {
          throw new MediaError('unsupported', 'empty audio output');
        }
        // Copy out of the worker's transfer buffer into a standalone Blob.
        return new Blob([new Uint8Array(data)], { type: CHUNK_MIME_TYPE });
      } finally {
        if (ffmpeg.loaded) await ffmpeg.deleteFile(output).catch(() => undefined);
      }
    });
  }

  async dispose(): Promise<void> {
    const ffmpeg = this.mountedOn;
    this.mountedOn = null;
    if (ffmpeg?.loaded) {
      await serialize(() => ffmpeg.unmount(INPUT_DIR).catch(() => undefined));
    }
  }
}

function lastLines(log: string, count = 3): string {
  return log.trim().split('\n').slice(-count).join(' | ');
}
