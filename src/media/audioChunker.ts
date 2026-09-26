import { CHUNK_BITRATE_BPS, PREFERRED_MAX_CHUNK_SECONDS, SILENCE_SEARCH_SECONDS, TARGET_CHUNK_BYTES } from '../config';
import type { SilenceInterval } from '../types/media';

/**
 * How chunk length is chosen
 * --------------------------
 * Chunks are sized primarily by their *encoded size*: we encode constant-bitrate
 * MP3, so size ≈ duration × bitrate / 8, and the longest chunk that fits the
 * target (20 MB of the 25 MB API limit) is TARGET_CHUNK_BYTES·8 / bitrate.
 * That bound is then lowered by (a) the model's own input-duration limit and
 * (b) a preferred maximum that limits how much work a failed request loses.
 * After encoding, the real size is checked again (see transcriptionQueue).
 */
export function maxChunkSeconds(opts: {
  targetBytes?: number;
  bitrateBps?: number;
  modelMaxSeconds?: number;
  preferredMaxSeconds?: number;
} = {}): number {
  const targetBytes = opts.targetBytes ?? TARGET_CHUNK_BYTES;
  const bitrate = opts.bitrateBps ?? CHUNK_BITRATE_BPS;
  const bySize = Math.floor((targetBytes * 8) / bitrate);
  const byModel = opts.modelMaxSeconds ? Math.floor(opts.modelMaxSeconds * 0.9) : Infinity;
  const preferred = opts.preferredMaxSeconds ?? PREFERRED_MAX_CHUNK_SECONDS;
  return Math.max(60, Math.min(bySize, byModel, preferred));
}

/**
 * Picks where to cut inside a search window: the middle of the longest pause
 * (later pauses win ties, keeping chunks close to full length). Returns
 * undefined when there is no pause, in which case the nominal boundary is used.
 */
export function pickBoundary(silences: readonly SilenceInterval[], windowStart: number, windowEnd: number): number | undefined {
  let best: SilenceInterval | undefined;
  for (const s of silences) {
    const start = Math.max(s.start, windowStart);
    const end = Math.min(s.end, windowEnd);
    if (end <= start) continue;
    if (!best || end - start >= best.end - best.start) best = { start, end };
  }
  return best ? (best.start + best.end) / 2 : undefined;
}

export interface PlannedChunk {
  id: number;
  startTime: number;
  endTime: number;
}

/**
 * Splits [0, duration) into chunks no longer than `maxSeconds`, moving each cut
 * back to a pause found in the preceding `searchSeconds` so sentences are not
 * split mid-word. Only a few seconds of audio are decoded per boundary, so
 * planning a 2-hour file is quick and never loads the whole file.
 */
export async function planChunks(
  duration: number,
  maxSeconds: number,
  findSilences: (start: number, end: number) => Promise<SilenceInterval[]>,
  options: { searchSeconds?: number; onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
): Promise<PlannedChunk[]> {
  if (!(duration > 0)) throw new Error('Cannot plan chunks for media without a duration');
  const searchSeconds = Math.min(options.searchSeconds ?? SILENCE_SEARCH_SECONDS, maxSeconds / 2);
  const chunks: PlannedChunk[] = [];
  let start = 0;
  while (duration - start > maxSeconds) {
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const nominal = start + maxSeconds;
    const windowStart = nominal - searchSeconds;
    let cut = nominal;
    try {
      cut = pickBoundary(await findSilences(windowStart, nominal), windowStart, nominal) ?? nominal;
    } catch {
      // Silence detection is an optimisation only; fall back to a hard cut.
    }
    chunks.push({ id: chunks.length, startTime: start, endTime: cut });
    start = cut;
    options.onProgress?.(start / duration);
  }
  chunks.push({ id: chunks.length, startTime: start, endTime: duration });
  options.onProgress?.(1);
  return chunks;
}
