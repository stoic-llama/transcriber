import type { TranscriptionOptions, TranscriptResult } from '../types/transcription';

/**
 * A speech-to-text backend. The queue only depends on this interface, so a
 * future local Whisper/WebGPU provider can replace OpenAI without touching the
 * chunking, persistence or UI code.
 */
export interface TranscriptionProvider {
  readonly id: string;
  transcribe(audio: Blob, options?: TranscriptionOptions): Promise<TranscriptResult>;
}

export type TranscriptionErrorKind =
  /** Key missing, malformed or rejected (401). */
  | 'auth'
  /** Account has no quota / billing problem. */
  | 'quota'
  /** Key lacks access to the model or endpoint (403/404). */
  | 'permission'
  | 'rate_limit'
  | 'network'
  | 'timeout'
  /** 5xx from the provider. */
  | 'server'
  /** Provider rejected this particular audio (400/413/415). */
  | 'bad_request'
  /** Response did not look like a transcript. */
  | 'malformed'
  | 'aborted';

const RETRYABLE: ReadonlySet<TranscriptionErrorKind> = new Set([
  'rate_limit',
  'network',
  'timeout',
  'server',
  'malformed',
]);

/**
 * Errors that will affect every chunk equally; the queue stops instead of
 * burning through the remaining chunks.
 */
const FATAL_FOR_JOB: ReadonlySet<TranscriptionErrorKind> = new Set(['auth', 'quota', 'permission']);

export class TranscriptionError extends Error {
  readonly kind: TranscriptionErrorKind;
  readonly status?: number;
  /** Server-requested wait before retrying, if any. */
  readonly retryAfterMs?: number;
  /** Plain-language explanation for the UI. */
  readonly userMessage: string;

  constructor(
    kind: TranscriptionErrorKind,
    userMessage: string,
    options: { status?: number; retryAfterMs?: number; detail?: string; cause?: unknown } = {},
  ) {
    super(options.detail ? `${userMessage} (${options.detail})` : userMessage, { cause: options.cause });
    this.name = 'TranscriptionError';
    this.kind = kind;
    this.userMessage = userMessage;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }

  get retryable(): boolean {
    return RETRYABLE.has(this.kind);
  }

  get fatalForJob(): boolean {
    return FATAL_FOR_JOB.has(this.kind);
  }
}

export function isTranscriptionError(error: unknown): error is TranscriptionError {
  return error instanceof TranscriptionError;
}
