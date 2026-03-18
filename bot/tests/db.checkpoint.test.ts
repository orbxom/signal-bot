import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './helpers/testDb';

describe('DatabaseConnection.checkpoint', () => {
  let testDb: TestDb;

  afterEach(() => {
    testDb?.cleanup();
  });

  it('executes without error on an open database', () => {
    testDb = createTestDb();
    expect(() => testDb.conn.checkpoint()).not.toThrow();
  });

  it('throws "Database is closed" on a closed database', () => {
    testDb = createTestDb();
    testDb.conn.close();
    expect(() => testDb.conn.checkpoint()).toThrow('Database is closed');
  });
});
