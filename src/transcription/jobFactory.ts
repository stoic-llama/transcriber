import { maxChunkSeconds, planChunks } from '../media/audioChunker';
import { MediaError } from '../media/MediaError';
import { saveChunks } from '../storage/chunks';
import { saveJob } from '../storage/jobs';
import type { Chunk, JobWithChunks, TranscriptionJob } from '../types/jobs';
import type { AudioSource } from '../types/media';
import { getModelInfo } from './models';

export interface NewJobInput {
  file: { name: string; size: number; type: string; lastModified: number };
  fingerprint: string;
  model: string;
  language?: string;
  /** Duration from the browser's media element, used if ffmpeg reports none. */
  nativeDuration?: number;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

function newId(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Probes the media, plans silence-aligned chunk boundaries and persists the
 * job. The plan is stored, so a resumed job always uses the same boundaries.
 */
export async function createJob(source: AudioSource, input: NewJobInput): Promise<JobWithChunks> {
  const probe = await source.probe();
  const duration = Number.isFinite(probe.duration) && probe.duration > 0 ? probe.duration : input.nativeDuration;
  if (!duration || !(duration > 0)) {
    throw new MediaError('unsupported', 'could not determine duration');
  }

  const model = getModelInfo(input.model);
  const maxSeconds = maxChunkSeconds({ modelMaxSeconds: model.maxAudioSeconds });
  const plan = await planChunks(duration, maxSeconds, (s, e) => source.findSilences(s, e), {
    onProgress: input.onProgress,
    signal: input.signal,
  });

  const now = Date.now();
  const job: TranscriptionJob = {
    id: newId(),
    sourceFileName: input.file.name,
    sourceFileSize: input.file.size,
    sourceFileType: input.file.type,
    sourceLastModified: input.file.lastModified,
    fingerprint: input.fingerprint,
    duration,
    createdAt: now,
    updatedAt: now,
    status: 'pending',
    settings: { model: model.id, language: input.language || undefined, maxChunkSeconds: maxSeconds },
  };
  const chunks: Chunk[] = plan.map((p) => ({
    jobId: job.id,
    id: p.id,
    startTime: p.startTime,
    endTime: p.endTime,
    status: 'pending',
    attempts: 0,
    updatedAt: now,
  }));
  // Chunks first: a job record without chunks would look like a broken job.
  await saveChunks(chunks);
  await saveJob(job);
  return { job, chunks };
}
