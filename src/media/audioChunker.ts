import {
  CHUNK_BITRATE_BPS,
  CHUNK_OVERLAP_SECONDS,
  PREFERRED_MAX_CHUNK_SECONDS,
  SILENCE_SEARCH_SECONDS,
  TARGET_CHUNK_BYTES,
} from '../config';
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
  /** Start of the audio sent for this chunk, including the overlap with the previous chunk. */
  startTime: number;
  /** End of the audio sent for this chunk, including the overlap with the next chunk. */
  endTime: number;
}

/**
 * Turns cut points into chunks that each reach `overlapSeconds / 2` past every
 * cut, so adjacent chunks share `overlapSeconds` of audio centred on the cut.
 *
 * This is what keeps words safe when the cut is wrong: any stretch of speech no
 * longer than the overlap lies entirely inside at least one chunk, wherever the
 * cut lands (proof: take the last chunk starting at or before the word; the
 * next chunk starts after the word, and this chunk ends a full overlap later).
 */
export function chunksFromCuts(cuts: readonly number[], duration: number, overlapSeconds: number): PlannedChunk[] {
  const half = overlapSeconds / 2;
  const edges = [0, ...cuts, duration];
  return edges.slice(0, -1).map((cut, i) => ({
    id: i,
    startTime: i === 0 ? 0 : Math.max(0, cut - half),
    endTime: i === edges.length - 2 ? duration : Math.min(duration, edges[i + 1] + half),
  }));
}

/**
 * Splits [0, duration) into overlapping chunks no longer than `maxSeconds`.
 * Each cut moves back to a pause found in the preceding `searchSeconds` so
 * sentences are not split mid-word, and chunks overlap by `overlapSeconds`
 * around every cut in case the pause was misdetected or none was found (then
 * the cut is a hard cut, possibly through a word). Only a few seconds of audio
 * are decoded per boundary, so planning a 2-hour file is quick and never loads
 * the whole file.
 */
export async function planChunks(
  duration: number,
  maxSeconds: number,
  findSilences: (start: number, end: number) => Promise<SilenceInterval[]>,
  options: {
    searchSeconds?: number;
    overlapSeconds?: number;
    onProgress?: (fraction: number) => void;
    signal?: AbortSignal;
  } = {},
): Promise<PlannedChunk[]> {
  if (!(duration > 0)) throw new Error('Cannot plan chunks for media without a duration');
  const overlap = options.overlapSeconds ?? CHUNK_OVERLAP_SECONDS;
  // Cuts end up at least span/2 apart; keeping that ≥ overlap means only
  // neighbouring chunks ever share audio.
  if (!(overlap >= 0) || maxSeconds < 3 * overlap) {
    throw new Error(`Chunk length ${maxSeconds}s is too short for a ${overlap}s overlap`);
  }
  // Distance between cuts, leaving room for the overlap on both sides.
  const span = maxSeconds - overlap;
  const searchSeconds = Math.min(options.searchSeconds ?? SILENCE_SEARCH_SECONDS, span / 2);
  const cuts: number[] = [];
  let start = 0;
  while (duration - start > span) {
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const nominal = start + span;
    const windowStart = nominal - searchSeconds;
    let cut = nominal;
    try {
      cut = pickBoundary(await findSilences(windowStart, nominal), windowStart, nominal) ?? nominal;
    } catch {
      // Silence detection is an optimisation only; fall back to a hard cut.
    }
    // Too close to the end for a full overlap: this chunk can take the rest
    // (it is then at most span + overlap/2 long).
    if (cut > duration - overlap / 2) break;
    cuts.push(cut);
    start = cut;
    options.onProgress?.(start / duration);
  }
  options.onProgress?.(1);
  return chunksFromCuts(cuts, duration, overlap);
}
