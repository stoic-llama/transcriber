import { describe, expect, it } from 'vitest';
import { getChunks } from '../storage/chunks';
import { findJobsByFingerprint } from '../storage/jobs';
import { FakeAudioSource } from '../test/fakes';
import { createJob } from './jobFactory';

const file = { name: 'Lecture.mp4', size: 123, type: 'video/mp4', lastModified: 5 };

describe('createJob', () => {
  it('plans and persists a job for a 2-hour recording', async () => {
    const source = new FakeAudioSource({ duration: 7380, hasAudio: true });
    const { job, chunks } = await createJob(source, { file, fingerprint: 'fp1', model: 'gpt-4o-transcribe' });
    expect(job.status).toBe('pending');
    expect(job.duration).toBe(7380);
    expect(job.settings.model).toBe('gpt-4o-transcribe');
    expect(chunks.length).toBe(13);
    expect(chunks.every((c) => c.endTime - c.startTime <= job.settings.maxChunkSeconds)).toBe(true);
    expect((await getChunks(job.id)).length).toBe(13);
    expect((await findJobsByFingerprint('fp1')).map((j) => j.id)).toEqual([job.id]);
  });

  it('uses the native duration when ffmpeg cannot report one', async () => {
    const source = new FakeAudioSource({ duration: NaN, hasAudio: true });
    const { job } = await createJob(source, { file, fingerprint: 'fp', model: 'gpt-transcribe', nativeDuration: 90 });
    expect(job.duration).toBe(90);
  });

  it('rejects media without a usable duration', async () => {
    const source = new FakeAudioSource({ duration: NaN, hasAudio: true });
    await expect(createJob(source, { file, fingerprint: 'fp', model: 'gpt-transcribe' })).rejects.toMatchObject({
      kind: 'unsupported',
    });
  });
});
