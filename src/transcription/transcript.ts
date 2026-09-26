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

/** All transcript segments in timeline order. */
export function assembleSegments(chunks: readonly Chunk[]): TranscriptSegment[] {
  return orderedChunks(chunks).flatMap((c) => c.segments ?? []);
}

/**
 * Plain-text transcript. Chunk boundaries fall on pauses, so each chunk becomes
 * a paragraph.
 */
export function assembleTranscriptText(chunks: readonly Chunk[]): string {
  return (
    orderedChunks(chunks)
      .map((c) => (c.transcript ?? '').trim())
      .filter(Boolean)
      .join('\n\n') + '\n'
  );
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
