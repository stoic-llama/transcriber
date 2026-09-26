import type { AudioSource, MediaProbe, SilenceInterval } from '../types/media';
import type { TranscriptionOptions, TranscriptResult } from '../types/transcription';
import type { TranscriptionProvider } from '../transcription/TranscriptionProvider';
import { saveChunks } from '../storage/chunks';
import { saveJob } from '../storage/jobs';
import type { Chunk, TranscriptionJob } from '../types/jobs';

/** Audio source whose "audio" is just the time range encoded as text. */
export class FakeAudioSource implements AudioSource {
  extracted: Array<[number, number]> = [];
  constructor(
    private readonly probeResult: MediaProbe = { duration: 3600, hasAudio: true },
    private readonly silences: SilenceInterval[] = [],
  ) {}
  async probe() {
    return this.probeResult;
  }
  async findSilences(start: number, end: number) {
    return this.silences.filter((s) => s.end > start && s.start < end);
  }
  async extract(start: number, end: number) {
    this.extracted.push([start, end]);
    return new Blob([`${start}-${end}`], { type: 'audio/mpeg' });
  }
  async dispose() {}
}

type Handler = (audio: Blob, options: TranscriptionOptions, call: number) => Promise<TranscriptResult>;

export class FakeProvider implements TranscriptionProvider {
  readonly id = 'fake';
  calls: Array<{ range: string; options: TranscriptionOptions }> = [];
  constructor(private handler: Handler = async (audio) => ({ text: `text of ${await audio.text()}` })) {}
  setHandler(handler: Handler) {
    this.handler = handler;
  }
  async transcribe(audio: Blob, options: TranscriptionOptions = {}) {
    this.calls.push({ range: await audio.text(), options });
    return this.handler(audio, options, this.calls.length);
  }
}

export async function seedJob(
  chunkStates: Array<Partial<Chunk> & { status: Chunk['status'] }>,
  jobPatch: Partial<TranscriptionJob> = {},
): Promise<{ job: TranscriptionJob; chunks: Chunk[] }> {
  const id = jobPatch.id ?? `job-${Math.random().toString(36).slice(2)}`;
  const now = Date.now();
  const chunks: Chunk[] = chunkStates.map((c, i) => ({
    jobId: id,
    id: i,
    startTime: i * 600,
    endTime: (i + 1) * 600,
    attempts: 0,
    updatedAt: now,
    ...c,
  }));
  const job: TranscriptionJob = {
    id,
    sourceFileName: 'Lecture.mp4',
    sourceFileSize: 1000,
    sourceFileType: 'video/mp4',
    sourceLastModified: 1,
    fingerprint: 'fp',
    duration: chunks.length * 600,
    createdAt: now,
    updatedAt: now,
    status: 'pending',
    settings: { model: 'gpt-transcribe', maxChunkSeconds: 600 },
    ...jobPatch,
  };
  await saveChunks(chunks);
  await saveJob(job);
  return { job, chunks };
}

export const instantSleep = async () => {};
