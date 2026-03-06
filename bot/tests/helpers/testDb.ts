import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseConnection } from '../../src/db';
import { Storage } from '../../src/storage';

export interface TestDb {
  conn: DatabaseConnection;
  dbPath: string;
  testDir: string;
  cleanup: () => void;
}

/**
 * Creates a temporary DatabaseConnection for store-level tests.
 * Call `cleanup()` in afterEach to close the connection and remove the temp directory.
 */
export function createTestDb(prefix = 'signal-bot-test-'): TestDb {
  const testDir = mkdtempSync(join(tmpdir(), prefix));
  const dbPath = join(testDir, 'test.db');
  const conn = new DatabaseConnection(dbPath);
  return {
    conn,
    dbPath,
    testDir,
    cleanup: () => {
      conn.close();
      rmSync(testDir, { recursive: true, force: true });
    },
  };
}

export interface TestStorage {
  storage: Storage;
  dbPath: string;
  testDir: string;
  cleanup: () => void;
}

/**
 * Creates a temporary Storage instance for facade-level tests.
 * Call `cleanup()` in afterEach to close the storage and remove the temp directory.
 */
export function createTestStorage(prefix = 'signal-bot-test-'): TestStorage {
  const testDir = mkdtempSync(join(tmpdir(), prefix));
  const dbPath = join(testDir, 'test.db');
  const storage = new Storage(dbPath);
  return {
    storage,
    dbPath,
    testDir,
    cleanup: () => {
      storage.close();
      rmSync(testDir, { recursive: true, force: true });
    },
  };
}
