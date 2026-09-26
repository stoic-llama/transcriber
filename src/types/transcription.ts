/** A span of transcript text positioned on the source media's timeline (seconds). */
export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  /** Reserved for future diarization support. */
  speaker?: string;
}

export interface TranscriptResult {
  text: string;
  /**
   * Timestamped segments, relative to the audio that was sent. Only some
   * models return these; when absent, the whole result is one segment.
   */
  segments?: TranscriptSegment[];
  language?: string;
}

export interface TranscriptionOptions {
  model?: string;
  /** ISO-639-1 language hint, e.g. "en". */
  language?: string;
  /** Context text (e.g. the end of the previous chunk) to improve continuity. */
  prompt?: string;
  /** File name reported to the API; the extension tells it the format. */
  fileName?: string;
  signal?: AbortSignal;
}
