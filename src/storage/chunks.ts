import type { Chunk } from '../types/jobs';
import { getDb } from './db';

/** Chunks of a job in chronological order. */
export async function getChunks(jobId: string): Promise<Chunk[]> {
  const db = await getDb();
  const chunks = await db.getAllFromIndex('chunks', 'byJob', jobId);
  return chunks.sort((a, b) => a.id - b.id);
}

export async function getChunk(jobId: string, id: number): Promise<Chunk | undefined> {
  const db = await getDb();
  return db.get('chunks', [jobId, id]);
}

export async function saveChunks(chunks: Chunk[]): Promise<void> {
  const db = await getDb();
  const tx = db.transaction('chunks', 'readwrite');
  await Promise.all(chunks.map((chunk) => tx.store.put(chunk)));
  await tx.done;
}

export async function saveChunk(chunk: Chunk): Promise<void> {
  const db = await getDb();
  await db.put('chunks', { ...chunk, updatedAt: Date.now() });
}

export async function updateChunk(
  jobId: string,
  id: number,
  patch: Partial<Omit<Chunk, 'jobId' | 'id'>>,
): Promise<Chunk> {
  const db = await getDb();
  const tx = db.transaction('chunks', 'readwrite');
  const current = await tx.store.get([jobId, id]);
  if (!current) throw new Error(`Chunk ${id} of job ${jobId} not found`);
  const next: Chunk = { ...current, ...patch, jobId, id, updatedAt: Date.now() };
  await tx.store.put(next);
  await tx.done;
  return next;
}
