import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach } from 'vitest';
import { resetDbConnection } from '../storage/db';

// Fresh, empty IndexedDB for every test.
beforeEach(async () => {
  await resetDbConnection();
  globalThis.indexedDB = new IDBFactory();
});
