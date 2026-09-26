import { API_MAX_UPLOAD_BYTES, CHUNK_EXTENSION, CONTEXT_PROMPT_CHARS, FALLBACK_BITRATE_BPS } from '../config';
import { MediaError } from '../media/MediaError';
import { getChunks, updateChunk } from '../storage/chunks';
import { getJob, updateJob } from '../storage/jobs';
import type { Chunk, JobStatus, TranscriptionJob } from '../types/jobs';
import type { AudioSource } from '../types/media';
import { isAbortError, retryWithBackoff, type RetryOptions } from '../utils/retry';
import { contextTail, isJobComplete, toSourceSegments } from './transcript';
import { isTranscriptionError, TranscriptionError, type TranscriptionProvider } from './TranscriptionProvider';

export type QueueOutcome =
  /** Every chunk of the job is transcribed. */
  | 'completed'
  /** Stopped at the user's request; nothing lost. */
  | 'paused'
  | 'cancelled'
  /** Ran out of work but some chunks failed; they can be retried. */
  | 'failed'
  /** An error that affects all chunks (bad key, no quota…) stopped the run. */
  | 'stopped';

export type QueueEvent =
  | { type: 'job'; job: TranscriptionJob }
  | { type: 'chunk'; chunk: Chunk }
  | { type: 'activity'; chunkId: number; activity: 'extracting' | 'transcribing' }
  | { type: 'retrying'; chunkId: number; attempt: number; delayMs: number; message: string };

export interface QueueDeps {
  provider: TranscriptionProvider;
  source: AudioSource;
  /** Overrides for tests (e.g. an instant `sleep`). */
  retry?: Partial<Omit<RetryOptions, 'isRetryable'>>;
}

export interface RunOptions {
  /** Restrict the run to these chunk ids (used by per-chunk "Retry"). */
  onlyChunkIds?: number[];
}

/** User-facing text for any error that can come out of a chunk. */
export function describeError(error: unknown): string {
  if (isTranscriptionError(error) || error instanceof MediaError) return error.userMessage;
  if (error instanceof Error && error.message) return `Unexpected error: ${error.message}`;
  return 'Unexpected error.';
}

function isFatalForJob(error: unknown): boolean {
  if (isTranscriptionError(error)) return error.fatalForJob;
  if (error instanceof MediaError) return error.kind !== 'unsupported';
  // Unknown errors (e.g. IndexedDB failures) are safest treated as fatal.
  return true;
}

/**
 * Processes a job's chunks strictly in chronological order, one at a time:
 *
 *   extract chunk → send to provider → save transcript → release audio → next
 *
 * Completed chunks are never re-sent. Every state change is written to
 * IndexedDB before moving on, so a crash loses at most the chunk in flight.
 * The next chunk's audio is prepared while the current one is being
 * transcribed (at most two small blobs in memory).
 *
 * Concurrency is 1 by design; the per-chunk logic lives in `processChunk` so a
 * small worker pool could be added later.
 */
export class TranscriptionQueue {
  private readonly jobId: string;
  private readonly deps: QueueDeps;
  private readonly listener: (event: QueueEvent) => void;
  private readonly controller = new AbortController();
  private pauseRequested = false;
  private running = false;

  constructor(jobId: string, deps: QueueDeps, listener: (event: QueueEvent) => void = () => {}) {
    this.jobId = jobId;
    this.deps = deps;
    this.listener = listener;
  }

  /** Finish the chunk in flight, then stop. */
  pause(): void {
    this.pauseRequested = true;
  }

  /** Abort the request in flight and stop. Completed chunks are untouched. */
  cancel(): void {
    this.controller.abort();
  }

  get isRunning(): boolean {
    return this.running;
  }

  async run(options: RunOptions = {}): Promise<QueueOutcome> {
    if (this.running) throw new Error('Queue is already running');
    this.running = true;
    try {
      return await this.runInner(options);
    } finally {
      this.running = false;
    }
  }

  private async runInner(options: RunOptions): Promise<QueueOutcome> {
    const job = await getJob(this.jobId);
    if (!job) throw new Error(`Job ${this.jobId} not found`);
    const all = await getChunks(this.jobId);
    const targets = all.filter(
      (c) => c.status !== 'completed' && (!options.onlyChunkIds || options.onlyChunkIds.includes(c.id)),
    );
    const transcripts = new Map(all.map((c) => [c.id, c.transcript]));

    await this.setJob({ status: 'transcribing', error: undefined });

    let outcome: QueueOutcome | undefined;
    // Mutated from the callback below, hence a holder object.
    const prefetch: { current: { id: number; audio: Promise<Blob> } | null } = { current: null };

    for (let i = 0; i < targets.length; i++) {
      if (this.controller.signal.aborted) {
        outcome = 'cancelled';
        break;
      }
      if (this.pauseRequested) {
        outcome = 'paused';
        break;
      }
      const chunk = targets[i];
      const prefetched = prefetch.current;
      const audio = prefetched?.id === chunk.id ? prefetched.audio : this.prepareAudio(chunk);
      audio.catch(() => undefined); // awaited (and reported) inside processChunk
      prefetch.current = null;

      const next = targets[i + 1];
      const startPrefetch = () => {
        if (next && !this.pauseRequested && !this.controller.signal.aborted) {
          const p = this.prepareAudio(next);
          p.catch(() => undefined); // awaited (and reported) when that chunk is processed
          prefetch.current = { id: next.id, audio: p };
        }
      };

      const result = await this.processChunk(job, chunk, audio, transcripts.get(chunk.id - 1), startPrefetch);
      if (result.status === 'completed') {
        transcripts.set(chunk.id, result.transcript);
      } else if (result.status === 'aborted') {
        outcome = 'cancelled';
        break;
      } else if (result.fatal) {
        await this.setJob({ error: result.error });
        outcome = 'stopped';
        break;
      }
    }

    const finalChunks = await getChunks(this.jobId);
    if (isJobComplete(finalChunks)) {
      await this.setJob({ status: 'completed', error: undefined });
      return 'completed';
    }
    const anyFailed = finalChunks.some((c) => c.status === 'failed');
    if (!outcome) outcome = anyFailed ? 'failed' : 'paused';
    const status: JobStatus = outcome === 'stopped' || outcome === 'failed' ? 'failed' : 'paused';
    await this.setJob({ status });
    return outcome;
  }

  private async processChunk(
    job: TranscriptionJob,
    chunk: Chunk,
    audioPromise: Promise<Blob>,
    previousTranscript: string | undefined,
    onAudioReady: () => void,
  ): Promise<
    | { status: 'completed'; transcript: string }
    | { status: 'failed'; error: string; fatal: boolean }
    | { status: 'aborted' }
  > {
    const signal = this.controller.signal;
    let current = await this.setChunk(chunk.id, { status: 'processing', error: undefined });
    this.listener({ type: 'activity', chunkId: chunk.id, activity: 'extracting' });

    try {
      let audio: Blob | null = await audioPromise;
      onAudioReady();
      this.listener({ type: 'activity', chunkId: chunk.id, activity: 'transcribing' });

      const result = await retryWithBackoff(
        async () => {
          current = await this.setChunk(chunk.id, { attempts: current.attempts + 1 });
          return this.deps.provider.transcribe(audio as Blob, {
            model: job.settings.model,
            language: job.settings.language,
            prompt: contextTail(previousTranscript, CONTEXT_PROMPT_CHARS),
            fileName: `chunk-${String(chunk.id + 1).padStart(3, '0')}.${CHUNK_EXTENSION}`,
            signal,
          });
        },
        {
          ...this.deps.retry,
          signal,
          isRetryable: (e) => isTranscriptionError(e) && e.retryable,
          retryAfterMs: (e) => (isTranscriptionError(e) ? e.retryAfterMs : undefined),
          onRetry: (e, attempt, delayMs) =>
            this.listener({ type: 'retrying', chunkId: chunk.id, attempt, delayMs, message: describeError(e) }),
        },
      );
      audio = null; // release before the next chunk

      const transcript = result.text.trim();
      await this.setChunk(chunk.id, {
        status: 'completed',
        transcript,
        segments: toSourceSegments(result, chunk.startTime, chunk.endTime),
        error: undefined,
      });
      return { status: 'completed', transcript };
    } catch (error) {
      if (signal.aborted || isAbortError(error) || (isTranscriptionError(error) && error.kind === 'aborted')) {
        // Nothing was saved for this chunk; it simply goes back to the queue.
        await this.setChunk(chunk.id, { status: 'pending' });
        return { status: 'aborted' };
      }
      const message = describeError(error);
      await this.setChunk(chunk.id, { status: 'failed', error: message });
      return { status: 'failed', error: message, fatal: isFatalForJob(error) };
    }
  }

  /** Encodes a chunk and makes sure it fits the upload limit. */
  private async prepareAudio(chunk: Chunk): Promise<Blob> {
    const { source } = this.deps;
    let blob = await source.extract(chunk.startTime, chunk.endTime);
    if (blob.size > API_MAX_UPLOAD_BYTES) {
      blob = await source.extract(chunk.startTime, chunk.endTime, { bitrate: FALLBACK_BITRATE_BPS });
    }
    if (blob.size > API_MAX_UPLOAD_BYTES) {
      throw new TranscriptionError('bad_request', 'This audio chunk is too large to upload, even at reduced quality.');
    }
    return blob;
  }

  private async setChunk(id: number, patch: Partial<Chunk>): Promise<Chunk> {
    const chunk = await updateChunk(this.jobId, id, patch);
    this.listener({ type: 'chunk', chunk });
    return chunk;
  }

  private async setJob(patch: Partial<TranscriptionJob>): Promise<TranscriptionJob> {
    const job = await updateJob(this.jobId, patch);
    this.listener({ type: 'job', job });
    return job;
  }
}
