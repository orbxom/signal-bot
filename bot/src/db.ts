import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export function wrapSqliteError(error: unknown, operation: string): never {
  if (error instanceof Error) {
    if (error.message.includes('SQLITE_BUSY') || error.message.includes('SQLITE_LOCKED')) {
      throw new Error('Database is locked by another process');
    } else if (error.message.includes('ENOSPC')) {
      throw new Error(`Disk full: Cannot ${operation}`);
    } else if (error.message.includes('SQLITE_CORRUPT')) {
      throw new Error('Database corrupted');
    }
    throw new Error(`Failed to ${operation}: ${error.message}`);
  }
  throw error;
}

export class DatabaseConnection {
  readonly db: Database.Database;
  private closed = false;

  constructor(dbPath: string) {
    try {
      mkdirSync(path.dirname(dbPath), { recursive: true });
      this.db = new Database(dbPath);
      this.db.pragma('journal_mode = WAL');
      this.initTables();
      this.runMigrations();
    } catch (error) {
      if (error instanceof Error && error.message.includes('EACCES')) {
        throw new Error(`Permission denied: Cannot access database at ${dbPath}`);
      }
      wrapSqliteError(error, 'initialize database');
    }
  }

  private initTables(): void {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          groupId TEXT NOT NULL,
          sender TEXT NOT NULL,
          content TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          isBot INTEGER NOT NULL DEFAULT 0,
          attachments TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_group_timestamp
        ON messages(groupId, timestamp DESC);

        CREATE TABLE IF NOT EXISTS reminders (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          groupId TEXT NOT NULL,
          requester TEXT NOT NULL,
          reminderText TEXT NOT NULL,
          dueAt INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          retryCount INTEGER NOT NULL DEFAULT 0,
          createdAt INTEGER NOT NULL,
          sentAt INTEGER,
          mode TEXT NOT NULL DEFAULT 'simple'
        );

        CREATE INDEX IF NOT EXISTS idx_reminders_due
        ON reminders(status, dueAt);

        CREATE INDEX IF NOT EXISTS idx_reminders_group
        ON reminders(groupId, status);

        CREATE TABLE IF NOT EXISTS dossiers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          groupId TEXT NOT NULL,
          personId TEXT NOT NULL,
          displayName TEXT NOT NULL DEFAULT '',
          notes TEXT NOT NULL DEFAULT '',
          createdAt INTEGER NOT NULL,
          updatedAt INTEGER NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_dossiers_group_person
        ON dossiers(groupId, personId);

        CREATE INDEX IF NOT EXISTS idx_dossiers_group
        ON dossiers(groupId);

        CREATE TABLE IF NOT EXISTS personas (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          description TEXT NOT NULL,
          tags TEXT NOT NULL DEFAULT '',
          isDefault INTEGER NOT NULL DEFAULT 0,
          createdAt INTEGER NOT NULL,
          updatedAt INTEGER NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_personas_name
        ON personas(name COLLATE NOCASE);

        CREATE TABLE IF NOT EXISTS active_personas (
          groupId TEXT NOT NULL PRIMARY KEY,
          personaId INTEGER NOT NULL,
          activatedAt INTEGER NOT NULL,
          FOREIGN KEY (personaId) REFERENCES personas(id)
        );

        CREATE TABLE IF NOT EXISTS schema_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
    } catch (error) {
      wrapSqliteError(error, 'create tables');
    }
  }

  private runMigrations(): void {
    try {
      const currentVersion = this.getSchemaVersion();

      if (currentVersion < 1) {
        this.migrateToV1();
        this.setSchemaVersion(1);
      }

      if (currentVersion < 2) {
        this.migrateToV2();
        this.setSchemaVersion(2);
      }

      if (currentVersion < 3) {
        this.migrateToV3();
        this.setSchemaVersion(3);
      }

      if (currentVersion < 4) {
        this.migrateToV4();
        this.setSchemaVersion(4);
      }

      if (currentVersion < 5) {
        this.migrateToV5();
        this.setSchemaVersion(5);
      }

      if (currentVersion < 6) {
        this.migrateToV6();
        this.setSchemaVersion(6);
      }

      if (currentVersion < 7) {
        this.migrateToV7();
        this.setSchemaVersion(7);
      }

      if (currentVersion < 8) {
        this.migrateToV8();
        this.setSchemaVersion(8);
      }

      if (currentVersion < 9) {
        this.migrateToV9();
        this.setSchemaVersion(9);
      }

      if (currentVersion < 10) {
        this.migrateToV10();
        this.setSchemaVersion(10);
      }
    } catch (error) {
      wrapSqliteError(error, 'run migrations');
    }
  }

  private getSchemaVersion(): number {
    const row = this.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as
      | { value: string }
      | undefined;
    return row ? Number.parseInt(row.value, 10) : 0;
  }

  private setSchemaVersion(version: number): void {
    this.db
      .prepare(
        "INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(String(version));
  }

  private migrateToV1(): void {
    // Add attachments column to messages table (for databases created before it was in CREATE TABLE)
    const cols = this.db.pragma('table_info(messages)') as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'attachments')) {
      this.db.exec('ALTER TABLE messages ADD COLUMN attachments TEXT');
    }
  }

  private migrateToV2(): void {
    // Add lastAttemptAt and failureReason columns to reminders
    const cols = this.db.pragma('table_info(reminders)') as Array<{ name: string }>;
    const colNames = cols.map(c => c.name);

    if (!colNames.includes('lastAttemptAt')) {
      this.db.exec('ALTER TABLE reminders ADD COLUMN lastAttemptAt INTEGER');
    }
    if (!colNames.includes('failureReason')) {
      this.db.exec('ALTER TABLE reminders ADD COLUMN failureReason TEXT');
    }

    // Add composite index for group + status queries
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_reminders_group_status ON reminders(groupId, status, dueAt)');
  }

  private migrateToV3(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        groupId TEXT NOT NULL,
        topic TEXT NOT NULL,
        content TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );
    `);

    // Only create topic-based index if the table actually has the old topic column
    // (fresh databases created by initTables will have the new title column instead)
    const cols = this.db.pragma('table_info(memories)') as Array<{ name: string }>;
    if (cols.some(c => c.name === 'topic')) {
      this.db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_group_topic
        ON memories(groupId, topic);

        CREATE INDEX IF NOT EXISTS idx_memories_group
        ON memories(groupId);
      `);
    }
  }

  private migrateToV4(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS attachment_data (
        id TEXT PRIMARY KEY,
        groupId TEXT NOT NULL,
        sender TEXT NOT NULL,
        contentType TEXT NOT NULL,
        size INTEGER NOT NULL,
        filename TEXT,
        data BLOB NOT NULL,
        timestamp INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_attachment_data_group
      ON attachment_data(groupId, timestamp DESC);
    `);
  }

  private migrateToV5(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS recurring_reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        groupId TEXT NOT NULL,
        requester TEXT NOT NULL,
        promptText TEXT NOT NULL,
        cronExpression TEXT NOT NULL,
        timezone TEXT NOT NULL,
        nextDueAt INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        consecutiveFailures INTEGER NOT NULL DEFAULT 0,
        lastFiredAt INTEGER,
        lastInFlightAt INTEGER,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_recurring_status_due
      ON recurring_reminders(status, nextDueAt);

      CREATE INDEX IF NOT EXISTS idx_recurring_group
      ON recurring_reminders(groupId, status);
    `);
  }

  private migrateToV6(): void {
    const cols = this.db.pragma('table_info(reminders)') as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'mode')) {
      this.db.exec("ALTER TABLE reminders ADD COLUMN mode TEXT NOT NULL DEFAULT 'simple'");
    }
  }

  private migrateToV7(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tool_notification_settings (
        groupId TEXT NOT NULL PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 0,
        updatedAt INTEGER NOT NULL
      );
    `);
  }

  private migrateToV8(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS group_settings (
        groupId TEXT PRIMARY KEY,
        enabled INTEGER DEFAULT 1,
        customTriggers TEXT,
        contextWindowSize INTEGER,
        toolNotifications INTEGER DEFAULT 1,
        createdAt INTEGER,
        updatedAt INTEGER
      )
    `);
    // Migrate data from old table
    const rows = this.db.prepare('SELECT groupId, enabled, updatedAt FROM tool_notification_settings').all() as Array<{
      groupId: string;
      enabled: number;
      updatedAt: number;
    }>;
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO group_settings (groupId, toolNotifications, enabled, createdAt, updatedAt)
      VALUES (?, ?, 1, ?, ?)
    `);
    for (const row of rows) {
      insert.run(row.groupId, row.enabled, row.updatedAt, row.updatedAt);
    }
    this.db.exec('DROP TABLE IF EXISTS tool_notification_settings');
  }

  private migrateToV9(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS web_app_deployments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        groupId TEXT NOT NULL,
        sender TEXT NOT NULL,
        siteCount INTEGER NOT NULL,
        deployedAt INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_web_app_deployments_time
      ON web_app_deployments(deployedAt DESC);
    `);
  }

  private migrateToV10(): void {
    this.db.pragma('foreign_keys = ON');

    // Check if the old schema exists (has 'topic' column)
    const cols = this.db.pragma('table_info(memories)') as Array<{ name: string }>;
    const hasTopicColumn = cols.some(c => c.name === 'topic');

    if (hasTopicColumn) {
      // Migrate: create new table, copy data with topic→title, drop old, rename
      this.db.exec(`
        CREATE TABLE memories_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          groupId TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT,
          content TEXT,
          type TEXT NOT NULL DEFAULT 'text',
          createdAt INTEGER NOT NULL,
          updatedAt INTEGER NOT NULL
        );

        INSERT INTO memories_new (id, groupId, title, description, content, type, createdAt, updatedAt)
        SELECT id, groupId, topic, NULL, content, 'text', createdAt, updatedAt
        FROM memories;

        DROP TABLE memories;

        ALTER TABLE memories_new RENAME TO memories;
      `);
    } else {
      // Fresh database created by initTables already has the new schema — ensure columns exist
      const colNames = cols.map(c => c.name);
      if (!colNames.includes('title')) {
        this.db.exec(`
          CREATE TABLE memories_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            groupId TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT,
            content TEXT,
            type TEXT NOT NULL DEFAULT 'text',
            createdAt INTEGER NOT NULL,
            updatedAt INTEGER NOT NULL
          );
          DROP TABLE memories;
          ALTER TABLE memories_new RENAME TO memories;
        `);
      }
    }

    // Create indexes for the new memories schema
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_group_title
      ON memories(groupId, title);

      CREATE INDEX IF NOT EXISTS idx_memories_group
      ON memories(groupId);

      CREATE INDEX IF NOT EXISTS idx_memories_group_type
      ON memories(groupId, type);

      CREATE TABLE IF NOT EXISTS memory_tags (
        memoryId INTEGER NOT NULL,
        tag TEXT NOT NULL,
        UNIQUE(memoryId, tag),
        FOREIGN KEY (memoryId) REFERENCES memories(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_memory_tags_tag
      ON memory_tags(tag);
    `);
  }

  checkpoint(): void {
    this.ensureOpen();
    try {
      this.db.pragma('wal_checkpoint(TRUNCATE)');
    } catch (error) {
      wrapSqliteError(error, 'WAL checkpoint');
    }
  }

  runOp<T>(name: string, fn: () => T): T {
    this.ensureOpen();
    try {
      return fn();
    } catch (error) {
      wrapSqliteError(error, name);
    }
  }

  ensureOpen(): void {
    if (this.closed) {
      throw new Error('Database is closed');
    }
  }

  transaction<T>(fn: () => T): T {
    this.ensureOpen();
    const runTransaction = this.db.transaction(fn);
    return runTransaction();
  }

  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
}
