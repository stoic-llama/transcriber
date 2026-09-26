import type { TranscriptSegment } from './transcription';

export type JobStatus =
  /** Chunk boundaries are being computed; no chunks yet. */
  | 'planning'
  /** Chunks exist and some still need work. */
  | 'pending'
  | 'transcribing'
  | 'paused'
  /** Stopped with at least one failed chunk; can be retried. */
  | 'failed'
  | 'completed';

export type ChunkStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface Chunk {
  jobId: string;
  /** Chronological position, 0-based. Assembly always sorts by this. */
  id: number;
  startTime: number;
  endTime: number;
  status: ChunkStatus;
  attempts: number;
  transcript?: string;
  /** Segments on the source timeline (already offset by startTime). */
  segments?: TranscriptSegment[];
  /** User-facing error message for failed chunks. */
  error?: string;
  updatedAt: number;
}

export interface JobSettings {
  model: string;
  language?: string;
  maxChunkSeconds: number;
}

export interface TranscriptionJob {
  id: string;
  sourceFileName: string;
  sourceFileSize: number;
  sourceFileType: string;
  sourceLastModified: number;
  /** Lightweight content fingerprint; see utils/fileHash.ts. */
  fingerprint: string;
  duration: number;
  createdAt: number;
  updatedAt: number;
  status: JobStatus;
  settings: JobSettings;
  /** Last job-level error (e.g. rejected API key) shown in the UI. */
  error?: string;
}

/** A job together with its chunks, as the UI consumes it. */
export interface JobWithChunks {
  job: TranscriptionJob;
  chunks: Chunk[];
}
