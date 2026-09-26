import { describe, expect, it } from 'vitest';
import { getChunks } from '../storage/chunks';
import { getJob } from '../storage/jobs';
import { FakeAudioSource, FakeProvider, instantSleep, seedJob } from '../test/fakes';
import { assembleTranscriptText } from './transcript';
import { TranscriptionQueue, type QueueEvent } from './transcriptionQueue';
import { TranscriptionError } from './TranscriptionProvider';

function makeQueue(jobId: string, provider = new FakeProvider(), source = new FakeAudioSource()) {
  const events: QueueEvent[] = [];
  const queue = new TranscriptionQueue(
    jobId,
    { provider, source, retry: { sleep: instantSleep, maxAttempts: 3 } },
    (e) => events.push(e),
  );
  return { queue, provider, source, events };
}

describe('TranscriptionQueue', () => {
  it('transcribes all chunks in order and completes the job', async () => {
    const { job } = await seedJob([{ status: 'pending' }, { status: 'pending' }, { status: 'pending' }]);
    const { queue, provider } = makeQueue(job.id);
    await expect(queue.run()).resolves.toBe('completed');
    expect(provider.calls.map((c) => c.range)).toEqual(['0-600', '600-1200', '1200-1800']);
    const chunks = await getChunks(job.id);
    expect(chunks.every((c) => c.status === 'completed' && c.attempts === 1)).toBe(true);
    expect(chunks[1].segments).toEqual([{ start: 600, end: 1200, text: 'text of 600-1200' }]);
    expect((await getJob(job.id))?.status).toBe('completed');
    expect(assembleTranscriptText(chunks)).toBe('text of 0-600\n\ntext of 600-1200\n\ntext of 1200-1800\n');
  });

  it('resumes without re-transcribing completed chunks, retrying failed and continuing pending ones', async () => {
    const { job } = await seedJob([
      { status: 'completed', transcript: 'one', attempts: 1 },
      { status: 'completed', transcript: 'two', attempts: 1 },
      { status: 'completed', transcript: 'three', attempts: 1 },
      { status: 'failed', error: 'Could not reach OpenAI.', attempts: 5 },
      { status: 'pending' },
    ]);
    const { queue, provider, source } = makeQueue(job.id);
    await expect(queue.run()).resolves.toBe('completed');
    expect(provider.calls.map((c) => c.range)).toEqual(['1800-2400', '2400-3000']);
    expect(source.extracted).toEqual([
      [1800, 2400],
      [2400, 3000],
    ]);
    const chunks = await getChunks(job.id);
    expect(chunks.map((c) => c.transcript)).toEqual([
      'one',
      'two',
      'three',
      'text of 1800-2400',
      'text of 2400-3000',
    ]);
    expect(chunks[3].error).toBeUndefined();
  });

  it('passes the previous chunk transcript as context', async () => {
    const { job } = await seedJob([{ status: 'completed', transcript: 'the end of chunk one' }, { status: 'pending' }]);
    const { queue, provider } = makeQueue(job.id);
    await queue.run();
    expect(provider.calls[0].options.prompt).toBe('the end of chunk one');
    expect(provider.calls[0].options.model).toBe('gpt-transcribe');
  });

  it('retries transient errors with backoff and records attempts', async () => {
    const { job } = await seedJob([{ status: 'pending' }]);
    const provider = new FakeProvider(async (_a, _o, call) => {
      if (call < 3) throw new TranscriptionError('rate_limit', 'OpenAI rate limit reached.');
      return { text: 'finally' };
    });
    const { queue, events } = makeQueue(job.id, provider);
    await expect(queue.run()).resolves.toBe('completed');
    const [chunk] = await getChunks(job.id);
    expect(chunk).toMatchObject({ status: 'completed', transcript: 'finally', attempts: 3 });
    expect(events.filter((e) => e.type === 'retrying')).toHaveLength(2);
  });

  it('marks a chunk failed after exhausting retries and continues with the next chunk', async () => {
    const { job } = await seedJob([{ status: 'pending' }, { status: 'pending' }]);
    const provider = new FakeProvider(async (audio) => {
      if ((await audio.text()) === '0-600') throw new TranscriptionError('server', 'OpenAI is having problems.');
      return { text: 'ok' };
    });
    const { queue } = makeQueue(job.id, provider);
    await expect(queue.run()).resolves.toBe('failed');
    const chunks = await getChunks(job.id);
    expect(chunks[0]).toMatchObject({ status: 'failed', attempts: 3, error: 'OpenAI is having problems.' });
    expect(chunks[1]).toMatchObject({ status: 'completed', transcript: 'ok' });
    expect((await getJob(job.id))?.status).toBe('failed');
  });

  it('stops the whole job on an invalid API key instead of failing every chunk', async () => {
    const { job } = await seedJob([{ status: 'pending' }, { status: 'pending' }, { status: 'pending' }]);
    const provider = new FakeProvider(async () => {
      throw new TranscriptionError('auth', 'The OpenAI API key was rejected. Check your key and try again.');
    });
    const { queue } = makeQueue(job.id, provider);
    await expect(queue.run()).resolves.toBe('stopped');
    expect(provider.calls).toHaveLength(1); // not retried, not continued
    const chunks = await getChunks(job.id);
    expect(chunks.map((c) => c.status)).toEqual(['failed', 'pending', 'pending']);
    expect(chunks[0].error).toBe('The OpenAI API key was rejected. Check your key and try again.');
    const saved = await getJob(job.id);
    expect(saved?.status).toBe('failed');
    expect(saved?.error).toContain('API key was rejected');
  });

  it('retries a single failed chunk on request without touching others', async () => {
    const { job } = await seedJob([
      { status: 'completed', transcript: 'a' },
      { status: 'failed', error: 'x', attempts: 3 },
      { status: 'pending' },
    ]);
    const { queue, provider } = makeQueue(job.id);
    await expect(queue.run({ onlyChunkIds: [1] })).resolves.toBe('paused');
    expect(provider.calls.map((c) => c.range)).toEqual(['600-1200']);
    const chunks = await getChunks(job.id);
    expect(chunks.map((c) => c.status)).toEqual(['completed', 'completed', 'pending']);
    expect(chunks[1].attempts).toBe(4);
  });

  it('pauses after the chunk in flight and resumes later from where it stopped', async () => {
    const { job } = await seedJob([{ status: 'pending' }, { status: 'pending' }, { status: 'pending' }]);
    let queueRef: TranscriptionQueue | null = null;
    const provider = new FakeProvider(async (audio) => {
      queueRef?.pause(); // user presses Pause during the first request
      return { text: `t ${await audio.text()}` };
    });
    const first = makeQueue(job.id, provider);
    queueRef = first.queue;
    await expect(first.queue.run()).resolves.toBe('paused');
    expect((await getChunks(job.id)).map((c) => c.status)).toEqual(['completed', 'pending', 'pending']);
    expect((await getJob(job.id))?.status).toBe('paused');

    const second = makeQueue(job.id);
    await expect(second.queue.run()).resolves.toBe('completed');
    expect(second.provider.calls.map((c) => c.range)).toEqual(['600-1200', '1200-1800']);
  });

  it('cancel aborts the request in flight and leaves that chunk pending', async () => {
    const { job } = await seedJob([{ status: 'completed', transcript: 'a' }, { status: 'pending' }]);
    let queueRef: TranscriptionQueue | null = null;
    const provider = new FakeProvider(
      (_audio, options) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () =>
            reject(new TranscriptionError('aborted', 'Transcription was stopped.')),
          );
          queueRef?.cancel();
        }),
    );
    const { queue } = makeQueue(job.id, provider);
    queueRef = queue;
    await expect(queue.run()).resolves.toBe('cancelled');
    const chunks = await getChunks(job.id);
    expect(chunks.map((c) => c.status)).toEqual(['completed', 'pending']);
    expect(chunks[0].transcript).toBe('a');
  });

  it('keeps chunk order in the final transcript even if chunks complete out of order', async () => {
    const { job } = await seedJob([{ status: 'pending' }, { status: 'pending' }, { status: 'pending' }]);
    // Chunk 3 completes first, then chunk 1, then chunk 2 (e.g. via retries of individual chunks).
    await makeQueue(job.id).queue.run({ onlyChunkIds: [2] });
    await makeQueue(job.id).queue.run({ onlyChunkIds: [0] });
    await makeQueue(job.id).queue.run({ onlyChunkIds: [1] });
    const chunks = await getChunks(job.id);
    expect(chunks[2].updatedAt).toBeLessThanOrEqual(chunks[1].updatedAt);
    expect(assembleTranscriptText(chunks)).toBe('text of 0-600\n\ntext of 600-1200\n\ntext of 1200-1800\n');
    expect((await getJob(job.id))?.status).toBe('completed');
  });

  it('marks a chunk failed when its audio cannot be extracted', async () => {
    const { job } = await seedJob([{ status: 'pending' }, { status: 'pending' }]);
    const source = new FakeAudioSource();
    source.extract = async (start: number, end: number) => {
      if (start === 0) {
        const { MediaError } = await import('../media/MediaError');
        throw new MediaError('unsupported');
      }
      return new Blob([`${start}-${end}`]);
    };
    const { queue } = makeQueue(job.id, new FakeProvider(), source);
    await expect(queue.run()).resolves.toBe('failed');
    const chunks = await getChunks(job.id);
    expect(chunks[0].status).toBe('failed');
    expect(chunks[0].error).toMatch(/could not process this media format/);
    expect(chunks[1].status).toBe('completed');
  });

  it('re-encodes at a lower bitrate if a chunk exceeds the upload limit', async () => {
    const { job } = await seedJob([{ status: 'pending' }]);
    const source = new FakeAudioSource();
    const bitrates: Array<number | undefined> = [];
    source.extract = async (_s: number, _e: number, options?: { bitrate?: number }) => {
      bitrates.push(options?.bitrate);
      const size = options?.bitrate ? 1000 : 26 * 1024 * 1024;
      return new Blob([new Uint8Array(size)]);
    };
    const { queue } = makeQueue(job.id, new FakeProvider(async () => ({ text: 'ok' })), source);
    await expect(queue.run()).resolves.toBe('completed');
    expect(bitrates).toEqual([undefined, 24_000]);
  });
});
