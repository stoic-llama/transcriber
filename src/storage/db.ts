import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Chunk, TranscriptionJob } from '../types/jobs';

export const DB_NAME = 'local-transcriber';
const DB_VERSION = 1;

/**
 * Two stores so that saving one chunk's transcript is a small write instead of
 * rewriting the whole job. No media is stored here — only metadata and text.
 */
interface TranscriberDB extends DBSchema {
  jobs: {
    key: string;
    value: TranscriptionJob;
    indexes: { byFingerprint: string };
  };
  chunks: {
    key: [string, number];
    value: Chunk;
    indexes: { byJob: string };
  };
}

export type Database = IDBPDatabase<TranscriberDB>;

let dbPromise: Promise<Database> | null = null;

export function getDb(): Promise<Database> {
  if (!dbPromise) {
    dbPromise = openDB<TranscriberDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const jobs = db.createObjectStore('jobs', { keyPath: 'id' });
        jobs.createIndex('byFingerprint', 'fingerprint');
        const chunks = db.createObjectStore('chunks', { keyPath: ['jobId', 'id'] });
        chunks.createIndex('byJob', 'jobId');
      },
      blocking() {
        // Another tab wants a newer schema; let it proceed.
        void dbPromise?.then((db) => db.close());
        dbPromise = null;
      },
    }).catch((error: unknown) => {
      dbPromise = null;
      throw error;
    });
  }
  return dbPromise;
}

/** Test helper: close and forget the cached connection. */
export async function resetDbConnection(): Promise<void> {
  if (dbPromise) {
    const db = await dbPromise.catch(() => null);
    db?.close();
  }
  dbPromise = null;
}
