import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseConnection } from '../src/db';
import { createTestDb, type TestDb } from './helpers/testDb';

describe('DatabaseConnection', () => {
  let db: TestDb | undefined;
  let manualTestDir: string | undefined;

  /** For tests that need to control DatabaseConnection lifecycle manually */
  const createManualTestDbPath = () => {
    manualTestDir = mkdtempSync(join(tmpdir(), 'signal-bot-db-test-'));
    return join(manualTestDir, 'test.db');
  };

  afterEach(() => {
    db?.cleanup();
    db = undefined;
    if (manualTestDir) {
      rmSync(manualTestDir, { recursive: true, force: true });
      manualTestDir = undefined;
    }
  });

  describe('table creation', () => {
    it('should create all tables on fresh database', () => {
      db = createTestDb('signal-bot-db-test-');
      const tables = db.conn.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as Array<{ name: string }>;
      const tableNames = tables.map(t => t.name);
      expect(tableNames).toContain('messages');
      expect(tableNames).toContain('reminders');
      expect(tableNames).toContain('dossiers');
      expect(tableNames).toContain('personas');
      expect(tableNames).toContain('active_personas');
      expect(tableNames).toContain('schema_meta');
    });

    it('should set WAL journal mode', () => {
      db = createTestDb('signal-bot-db-test-');
      const result = db.conn.db.pragma('journal_mode') as Array<{ journal_mode: string }>;
      expect(result[0].journal_mode).toBe('wal');
    });
  });

  describe('migrations', () => {
    it('should add lastAttemptAt and failureReason columns to reminders', () => {
      db = createTestDb('signal-bot-db-test-');
      const cols = db.conn.db.pragma('table_info(reminders)') as Array<{ name: string }>;
      const colNames = cols.map(c => c.name);
      expect(colNames).toContain('lastAttemptAt');
      expect(colNames).toContain('failureReason');
    });

    it('should add idx_reminders_group_status index', () => {
      db = createTestDb('signal-bot-db-test-');
      const indexes = db.conn.db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='reminders'")
        .all() as Array<{ name: string }>;
      const indexNames = indexes.map(i => i.name);
      expect(indexNames).toContain('idx_reminders_group_status');
    });

    it('should be idempotent (running twice does not error)', () => {
      const dbPath = createManualTestDbPath();
      const conn1 = new DatabaseConnection(dbPath);
      conn1.close();
      expect(() => {
        const conn2 = new DatabaseConnection(dbPath);
        conn2.close();
      }).not.toThrow();
    });

    it('should preserve existing reminder data through migration', () => {
      const dbPath = createManualTestDbPath();
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

    it('should add attachments column to messages via migration for old databases', () => {
      const dbPath = createManualTestDbPath();
      // Create a pre-migration database without the attachments column
      const rawDb = new Database(dbPath);
      rawDb.pragma('journal_mode = WAL');
      rawDb.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          groupId TEXT NOT NULL,
          sender TEXT NOT NULL,
          content TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          isBot INTEGER NOT NULL DEFAULT 0
        );
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
        CREATE TABLE IF NOT EXISTS schema_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
      rawDb
        .prepare('INSERT INTO messages (groupId, sender, content, timestamp, isBot) VALUES (?, ?, ?, ?, ?)')
        .run('group1', 'Alice', 'Hello', 1000, 0);
      rawDb.close();

      // Now open with DatabaseConnection which runs migrations
      const conn = new DatabaseConnection(dbPath);
      try {
        const cols = conn.db.pragma('table_info(messages)') as Array<{ name: string }>;
        const colNames = cols.map(c => c.name);
        expect(colNames).toContain('attachments');

        // Verify existing data is preserved
        const row = conn.db.prepare('SELECT * FROM messages WHERE id = 1').get() as any;
        expect(row.groupId).toBe('group1');
        expect(row.content).toBe('Hello');
        expect(row.attachments).toBeNull();
      } finally {
        conn.close();
      }
    });

    it('should track schema version in schema_meta table', () => {
      db = createTestDb('signal-bot-db-test-');
      const row = db.conn.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as {
        value: string;
      };
      expect(Number.parseInt(row.value, 10)).toBeGreaterThanOrEqual(2);
    });

    it('should create memories table in v2 migration', () => {
      db = createTestDb('signal-bot-db-test-');
      const tables = db.conn.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as Array<{ name: string }>;
      expect(tables.map(t => t.name)).toContain('memories');
    });

    it('should create memories indexes in v2 migration', () => {
      db = createTestDb('signal-bot-db-test-');
      const indexes = db.conn.db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{
        name: string;
      }>;
      const indexNames = indexes.map(i => i.name);
      expect(indexNames).toContain('idx_memories_group_topic');
      expect(indexNames).toContain('idx_memories_group');
    });

    it('should create attachment_data table in v4 migration', () => {
      db = createTestDb('signal-bot-db-test-');
      const tables = db.conn.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='attachment_data'")
        .all() as Array<{ name: string }>;
      expect(tables).toHaveLength(1);

      const indexNames = (
        db.conn.db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{ name: string }>
      ).map(r => r.name);
      expect(indexNames).toContain('idx_attachment_data_group');
    });

    it('should set schema version to 5 after migrations', () => {
      db = createTestDb('signal-bot-db-test-');
      const row = db.conn.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as {
        value: string;
      };
      expect(Number.parseInt(row.value, 10)).toBe(5);
    });
  });

  describe('transaction', () => {
    it('should commit on success', () => {
      db = createTestDb('signal-bot-db-test-');
      const { conn } = db;
      conn.transaction(() => {
        conn.db.prepare("INSERT INTO schema_meta (key, value) VALUES ('test_key', 'test_value')").run();
      });
      const row = conn.db.prepare("SELECT value FROM schema_meta WHERE key = 'test_key'").get() as {
        value: string;
      };
      expect(row.value).toBe('test_value');
    });

    it('should roll back on error', () => {
      db = createTestDb('signal-bot-db-test-');
      const { conn } = db;
      expect(() => {
        conn.transaction(() => {
          conn.db.prepare("INSERT INTO schema_meta (key, value) VALUES ('rollback_key', 'rollback_value')").run();
          throw new Error('Intentional error');
        });
      }).toThrow('Intentional error');

      const row = conn.db.prepare("SELECT value FROM schema_meta WHERE key = 'rollback_key'").get();
      expect(row).toBeUndefined();
    });
  });

  describe('ensureOpen', () => {
    it('should throw after close()', () => {
      const dbPath = createManualTestDbPath();
      const conn = new DatabaseConnection(dbPath);
      conn.close();
      expect(() => conn.ensureOpen()).toThrow('Database is closed');
    });

    it('should not throw while open', () => {
      db = createTestDb('signal-bot-db-test-');
      const { conn } = db;
      expect(() => conn.ensureOpen()).not.toThrow();
    });
  });

  describe('close', () => {
    it('should be idempotent', () => {
      const dbPath = createManualTestDbPath();
      const conn = new DatabaseConnection(dbPath);
      conn.close();
      expect(() => conn.close()).not.toThrow();
    });
  });
});
