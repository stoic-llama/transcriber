import { describe, expect, it } from 'vitest';
import { seedJob } from '../test/fakes';
import { getChunks, updateChunk } from './chunks';
import { resetDbConnection } from './db';
import {
  deleteJob,
  findJobsByFingerprint,
  getJob,
  listJobs,
  loadJobWithChunks,
  recoverInterruptedJobs,
  updateJob,
} from './jobs';

describe('job persistence', () => {
  it('persists jobs and chunks across a reconnect (page reload)', async () => {
    const { job } = await seedJob([{ status: 'completed', transcript: 'one' }, { status: 'pending' }]);
    await resetDbConnection(); // simulate a new page load with the same IndexedDB
    const loaded = await loadJobWithChunks(job.id);
    expect(loaded?.job.sourceFileName).toBe('Lecture.mp4');
    expect(loaded?.chunks.map((c) => c.status)).toEqual(['completed', 'pending']);
    expect(loaded?.chunks[0].transcript).toBe('one');
  });

  it('saves individual chunk updates immediately', async () => {
    const { job } = await seedJob([{ status: 'pending' }, { status: 'pending' }]);
    await updateChunk(job.id, 1, { status: 'completed', transcript: 'two' });
    await resetDbConnection();
    const chunks = await getChunks(job.id);
    expect(chunks[1]).toMatchObject({ status: 'completed', transcript: 'two' });
    expect(chunks[0].status).toBe('pending');
  });

  it('finds jobs by file fingerprint and lists newest first', async () => {
    const a = await seedJob([{ status: 'pending' }], { id: 'a', fingerprint: 'x', updatedAt: 1 });
    await seedJob([{ status: 'pending' }], { id: 'b', fingerprint: 'y', updatedAt: 2 });
    expect((await findJobsByFingerprint('x')).map((j) => j.id)).toEqual([a.job.id]);
    await updateJob('a', { status: 'paused' });
    expect((await listJobs()).map((j) => j.id)).toEqual(['a', 'b']);
  });

  it('deletes a job and all of its chunks, leaving other jobs alone', async () => {
    const keep = await seedJob([{ status: 'completed', transcript: 'k' }]);
    const gone = await seedJob([{ status: 'completed', transcript: 'x' }, { status: 'pending' }]);
    await deleteJob(gone.job.id);
    expect(await getJob(gone.job.id)).toBeUndefined();
    expect(await getChunks(gone.job.id)).toEqual([]);
    expect(await getJob(keep.job.id)).toBeDefined();
    expect(await getChunks(keep.job.id)).toHaveLength(1);
  });

  it('recovers chunks and jobs interrupted by a crash', async () => {
    const { job } = await seedJob(
      [{ status: 'completed', transcript: 'a' }, { status: 'processing' }, { status: 'pending' }],
      { status: 'transcribing' },
    );
    await recoverInterruptedJobs();
    expect((await getChunks(job.id)).map((c) => c.status)).toEqual(['completed', 'pending', 'pending']);
    expect((await getJob(job.id))?.status).toBe('paused');
  });
});
