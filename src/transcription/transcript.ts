import type { Chunk } from '../types/jobs';
import type { TranscriptResult, TranscriptSegment } from '../types/transcription';

/**
 * Converts a provider result (timed relative to the chunk) into segments on the
 * source media's timeline. Without provider segments the whole chunk becomes
 * one segment, which keeps SRT/VTT export possible at chunk granularity.
 */
export function toSourceSegments(
  result: TranscriptResult,
  chunkStart: number,
  chunkEnd: number,
): TranscriptSegment[] {
  if (result.segments && result.segments.length > 0) {
    return result.segments.map((s) => ({
      ...s,
      start: chunkStart + s.start,
      end: Math.min(chunkEnd, chunkStart + s.end),
      text: s.text.trim(),
    }));
  }
  const text = result.text.trim();
  return text ? [{ start: chunkStart, end: chunkEnd, text }] : [];
}

/**
 * Chunks in chronological order, regardless of the order they were stored or
 * completed in.
 */
export function orderedChunks(chunks: readonly Chunk[]): Chunk[] {
  return [...chunks].sort((a, b) => a.id - b.id);
}

/**
 * Where `a` and the next chunk `b` were cut: the middle of the audio they
 * share, or undefined if they are not neighbours that overlap. (Jobs planned
 * before chunks overlapped simply have no shared audio.)
 */
function sharedCut(a: Chunk | undefined, b: Chunk | undefined): number | undefined {
  if (!a || !b || b.id !== a.id + 1 || !(a.endTime > b.startTime)) return undefined;
  return (a.endTime + b.startTime) / 2;
}

/**
 * All transcript segments in timeline order. Neighbouring chunks share audio
 * around each cut, so a segment is kept only by the chunk whose side of the cut
 * its midpoint falls on.
 */
export function assembleSegments(chunks: readonly Chunk[]): TranscriptSegment[] {
  const ordered = orderedChunks(chunks);
  return ordered.flatMap((c, i) => {
    const from = sharedCut(ordered[i - 1], c) ?? -Infinity;
    const to = sharedCut(c, ordered[i + 1]) ?? Infinity;
    return (c.segments ?? []).filter((s) => {
      const mid = (s.start + s.end) / 2;
      return mid >= from && mid < to;
    });
  });
}

interface Word {
  /** Lower-cased, punctuation stripped; empty for tokens that are only punctuation. */
  key: string;
  from: number;
  to: number;
}

function words(text: string): Word[] {
  return [...text.matchAll(/\S+/g)].map((m) => ({
    key: m[0].toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''),
    from: m.index,
    to: m.index + m[0].length,
  }));
}

function sameRun(a: readonly string[], aFrom: number, b: readonly string[], bFrom: number, length: number): boolean {
  for (let n = 0; n < length; n++) {
    if (!a[aFrom + n] || a[aFrom + n] !== b[bFrom + n]) return false;
  }
  return true;
}

/** Whether `part` looks like `whole` cut short at the given end, as a model hears half a word. */
function isFragmentOf(part: string, whole: string | undefined, kept: 'start' | 'end'): boolean {
  if (!part || !whole || part.length >= whole.length) return false;
  return kept === 'start' ? whole.startsWith(part) : whole.endsWith(part);
}

/**
 * Finds the words two neighbouring chunks both transcribed from their shared
 * audio, given each chunk's normalised words. Returns how many words of `a` to
 * keep and of `b` to skip so they appear once.
 *
 * Both chunks heard the same audio from the start of `b` to the end of `a`,
 * so a genuine repeat is a suffix of `a` equal to a prefix of `b`, except that
 * each chunk's outermost word there may be half a word, misheard. So the
 * shared run may leave out at most one word at the end of `a` and one at the
 * start of `b`; dropping those takes the word from the chunk that heard it
 * whole.
 *
 * A wrong match deletes real words, for example "of the" at the end of one
 * sentence and the start of the next when the overlap fell in a pause. So a
 * match is used only with enough evidence, and otherwise nothing is removed:
 * a duplicated word is better than a lost one.
 * - A run of 4 or more words is accepted, along with its edge words.
 * - A shorter run is accepted only if every edge word it drops is visibly a
 *   fragment of the whole word the other chunk has there ("fo" / "four"), and
 *   run plus fragments add up to at least 3 words.
 * - The first word of `a` and the last of `b` never take part: they sit at
 *   those chunks' other cut, where a half-heard word may look like anything.
 */
export function findOverlap(a: readonly string[], b: readonly string[]): { keepA: number; skipB: number } {
  let best: { score: number; keepA: number; skipB: number } | undefined;
  for (const aEnd of [a.length, a.length - 1]) {
    for (const bStart of [0, 1]) {
      let run = 0;
      for (let n = Math.min(aEnd - 1, b.length - 1 - bStart); n >= 1 && !run; n--) {
        if (sameRun(a, aEnd - n, b, bStart, n)) run = n;
      }
      if (!run) continue;
      const drops: boolean[] = [];
      if (aEnd < a.length) drops.push(isFragmentOf(a[aEnd], b[bStart + run], 'start'));
      if (bStart > 0) drops.push(isFragmentOf(b[0], a[aEnd - run - 1], 'end'));
      const fragments = drops.filter(Boolean).length;
      const trusted = run >= 4 || (fragments === drops.length && run + fragments >= 3);
      if (trusted && (!best || run + fragments > best.score)) {
        best = { score: run + fragments, keepA: aEnd, skipB: bStart + run };
      }
    }
  }
  return best ? { keepA: best.keepA, skipB: best.skipB } : { keepA: a.length, skipB: 0 };
}

/**
 * Plain-text transcript, one paragraph per chunk. Neighbouring chunks overlap
 * (see planChunks), so the words both of them transcribed are kept once.
 */
export function assembleTranscriptText(chunks: readonly Chunk[]): string {
  const ordered = orderedChunks(chunks);
  const texts = ordered.map((c) => (c.transcript ?? '').trim());
  for (let i = 1; i < ordered.length; i++) {
    const cut = sharedCut(ordered[i - 1], ordered[i]);
    if (cut === undefined || !texts[i - 1] || !texts[i]) continue;
    const a = words(texts[i - 1]);
    const b = words(texts[i]);
    const { keepA, skipB } = findOverlap(
      a.map((w) => w.key),
      b.map((w) => w.key),
    );
    if (keepA < a.length) texts[i - 1] = texts[i - 1].slice(0, a[keepA - 1]?.to ?? 0).trim();
    if (skipB > 0) texts[i] = texts[i].slice(b[skipB]?.from ?? texts[i].length).trim();
  }
  return texts.filter(Boolean).join('\n\n') + '\n';
}

export function isJobComplete(chunks: readonly Chunk[]): boolean {
  return chunks.length > 0 && chunks.every((c) => c.status === 'completed');
}

/** Last `maxChars` of transcript text, cut at a word boundary. */
export function contextTail(text: string | undefined, maxChars: number): string | undefined {
  if (!text) return undefined;
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed || undefined;
  const tail = trimmed.slice(-maxChars);
  const firstSpace = tail.indexOf(' ');
  return firstSpace > 0 ? tail.slice(firstSpace + 1) : tail;
}
