import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseConnection } from '../src/db';

describe('DatabaseConnection', () => {
  let testDir: string;
  let testDbPath: string;

  const createTestDb = () => {
    testDir = mkdtempSync(join(tmpdir(), 'signal-bot-db-test-'));
    testDbPath = join(testDir, 'test.db');
    return testDbPath;
  };

  afterEach(() => {
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('table creation', () => {
    it('should create all tables on fresh database', () => {
      const conn = new DatabaseConnection(createTestDb());
      try {
        const tables = conn.db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
          .all() as Array<{ name: string }>;
        const tableNames = tables.map(t => t.name);
        expect(tableNames).toContain('messages');
        expect(tableNames).toContain('reminders');
        expect(tableNames).toContain('dossiers');
        expect(tableNames).toContain('personas');
        expect(tableNames).toContain('active_personas');
        expect(tableNames).toContain('schema_meta');
      } finally {
        conn.close();
      }
    });

    it('should set WAL journal mode', () => {
      const conn = new DatabaseConnection(createTestDb());
      try {
        const result = conn.db.pragma('journal_mode') as Array<{ journal_mode: string }>;
        expect(result[0].journal_mode).toBe('wal');
      } finally {
        conn.close();
      }
    });
  });

  describe('migrations', () => {
    it('should add lastAttemptAt and failureReason columns to reminders', () => {
      const conn = new DatabaseConnection(createTestDb());
      try {
        const cols = conn.db.pragma('table_info(reminders)') as Array<{ name: string }>;
        const colNames = cols.map(c => c.name);
        expect(colNames).toContain('lastAttemptAt');
        expect(colNames).toContain('failureReason');
      } finally {
        conn.close();
      }
    });

    it('should add idx_reminders_group_status index', () => {
      const conn = new DatabaseConnection(createTestDb());
      try {
        const indexes = conn.db
          .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='reminders'")
          .all() as Array<{ name: string }>;
        const indexNames = indexes.map(i => i.name);
        expect(indexNames).toContain('idx_reminders_group_status');
      } finally {
        conn.close();
      }
    });

    it('should be idempotent (running twice does not error)', () => {
      const dbPath = createTestDb();
      const conn1 = new DatabaseConnection(dbPath);
      conn1.close();
      expect(() => {
        const conn2 = new DatabaseConnection(dbPath);
        conn2.close();
      }).not.toThrow();
    });

    it('should preserve existing reminder data through migration', () => {
      const dbPath = createTestDb();
      // Create a pre-migration database manually
      const rawDb = new Database(dbPath);
      rawDb.pragma('journal_mode = WAL');
      rawDb.exec(`
        CREATE TABLE IF NOT EXISTS reminders (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          groupId TEXT NOT NULL,
          requester TEXT NOT NULL,
          reminderText TEXT NOT NULL,
          dueAt INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          retryCount INTEGER NOT NULL DEFAULT 0,
          createdAt INTEGER NOT NULL,
          sentAt INTEGER
        );
      `);
      rawDb
        .prepare(
          'INSERT INTO reminders (groupId, requester, reminderText, dueAt, status, retryCount, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run('group1', 'Alice', 'Buy milk', 1000, 'pending', 0, 900);
      rawDb.close();

      // Now open with DatabaseConnection which runs migrations
      const conn = new DatabaseConnection(dbPath);
      try {
        const row = conn.db.prepare('SELECT * FROM reminders WHERE id = 1').get() as any;
        expect(row.groupId).toBe('group1');
        expect(row.reminderText).toBe('Buy milk');
        expect(row.lastAttemptAt).toBeNull();
        expect(row.failureReason).toBeNull();
      } finally {
        conn.close();
      }
    });

    it('should track schema version in schema_meta table', () => {
      const conn = new DatabaseConnection(createTestDb());
      try {
        const row = conn.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as {
          value: string;
        };
        expect(Number.parseInt(row.value, 10)).toBeGreaterThanOrEqual(1);
      } finally {
        conn.close();
      }
    });

    it('should create memories table in v2 migration', () => {
      const conn = new DatabaseConnection(createTestDb());
      try {
        const tables = conn.db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
          .all() as Array<{ name: string }>;
        expect(tables.map(t => t.name)).toContain('memories');
      } finally {
        conn.close();
      }
    });

    it('should create memories indexes in v2 migration', () => {
      const conn = new DatabaseConnection(createTestDb());
      try {
        const indexes = conn.db
          .prepare("SELECT name FROM sqlite_master WHERE type='index'")
          .all() as Array<{ name: string }>;
        const indexNames = indexes.map(i => i.name);
        expect(indexNames).toContain('idx_memories_group_topic');
        expect(indexNames).toContain('idx_memories_group');
      } finally {
        conn.close();
      }
    });

    it('should set schema version to 2 after migrations', () => {
      const conn = new DatabaseConnection(createTestDb());
      try {
        const row = conn.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as {
          value: string;
        };
        expect(Number.parseInt(row.value, 10)).toBe(2);
      } finally {
        conn.close();
      }
    });
  });

  describe('transaction', () => {
    it('should commit on success', () => {
      const conn = new DatabaseConnection(createTestDb());
      try {
        conn.transaction(() => {
          conn.db.prepare("INSERT INTO schema_meta (key, value) VALUES ('test_key', 'test_value')").run();
        });
        const row = conn.db.prepare("SELECT value FROM schema_meta WHERE key = 'test_key'").get() as {
          value: string;
        };
        expect(row.value).toBe('test_value');
      } finally {
        conn.close();
      }
    });

    it('should roll back on error', () => {
      const conn = new DatabaseConnection(createTestDb());
      try {
        expect(() => {
          conn.transaction(() => {
            conn.db.prepare("INSERT INTO schema_meta (key, value) VALUES ('rollback_key', 'rollback_value')").run();
            throw new Error('Intentional error');
          });
        }).toThrow('Intentional error');

        const row = conn.db.prepare("SELECT value FROM schema_meta WHERE key = 'rollback_key'").get();
        expect(row).toBeUndefined();
      } finally {
        conn.close();
      }
    });
  });

  describe('ensureOpen', () => {
    it('should throw after close()', () => {
      const conn = new DatabaseConnection(createTestDb());
      conn.close();
      expect(() => conn.ensureOpen()).toThrow('Database is closed');
    });

    it('should not throw while open', () => {
      const conn = new DatabaseConnection(createTestDb());
      try {
        expect(() => conn.ensureOpen()).not.toThrow();
      } finally {
        conn.close();
      }
    });
  });

  describe('close', () => {
    it('should be idempotent', () => {
      const conn = new DatabaseConnection(createTestDb());
      conn.close();
      expect(() => conn.close()).not.toThrow();
    });
  });
});
