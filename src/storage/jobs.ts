import type { JobWithChunks, TranscriptionJob } from '../types/jobs';
import { getChunks } from './chunks';
import { getDb } from './db';

export async function saveJob(job: TranscriptionJob): Promise<void> {
  const db = await getDb();
  await db.put('jobs', job);
}

export async function getJob(id: string): Promise<TranscriptionJob | undefined> {
  const db = await getDb();
  return db.get('jobs', id);
}

export async function updateJob(
  id: string,
  patch: Partial<Omit<TranscriptionJob, 'id'>>,
): Promise<TranscriptionJob> {
  const db = await getDb();
  const tx = db.transaction('jobs', 'readwrite');
  const current = await tx.store.get(id);
  if (!current) throw new Error(`Job ${id} not found`);
  const next: TranscriptionJob = { ...current, ...patch, id, updatedAt: Date.now() };
  await tx.store.put(next);
  await tx.done;
  return next;
}

/** All jobs, newest first. */
export async function listJobs(): Promise<TranscriptionJob[]> {
  const db = await getDb();
  const jobs = await db.getAll('jobs');
  return jobs.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function findJobsByFingerprint(fingerprint: string): Promise<TranscriptionJob[]> {
  const db = await getDb();
  return db.getAllFromIndex('jobs', 'byFingerprint', fingerprint);
}

export async function loadJobWithChunks(id: string): Promise<JobWithChunks | undefined> {
  const job = await getJob(id);
  if (!job) return undefined;
  return { job, chunks: await getChunks(id) };
}

/** Removes a job and all of its chunk records in one transaction. */
export async function deleteJob(id: string): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(['jobs', 'chunks'], 'readwrite');
  const chunkStore = tx.objectStore('chunks');
  const keys = await chunkStore.index('byJob').getAllKeys(id);
  await Promise.all([...keys.map((key) => chunkStore.delete(key)), tx.objectStore('jobs').delete(id)]);
  await tx.done;
}

/**
 * Called on startup: a chunk left in "processing" means the tab died mid-request.
 * Its result was never saved, so it goes back to "pending". Running jobs become
 * "paused" so the UI offers Resume.
 */
export async function recoverInterruptedJobs(): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(['jobs', 'chunks'], 'readwrite');
  const chunkStore = tx.objectStore('chunks');
  let cursor = await chunkStore.openCursor();
  while (cursor) {
    if (cursor.value.status === 'processing') {
      await cursor.update({ ...cursor.value, status: 'pending', updatedAt: Date.now() });
    }
    cursor = await cursor.continue();
  }
  const jobStore = tx.objectStore('jobs');
  let jobCursor = await jobStore.openCursor();
  while (jobCursor) {
    if (jobCursor.value.status === 'transcribing') {
      await jobCursor.update({ ...jobCursor.value, status: 'paused' });
    }
    jobCursor = await jobCursor.continue();
  }
  await tx.done;
}
