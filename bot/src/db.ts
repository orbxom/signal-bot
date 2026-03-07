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
          sentAt INTEGER
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

      CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_group_topic
      ON memories(groupId, topic);

      CREATE INDEX IF NOT EXISTS idx_memories_group
      ON memories(groupId);
    `);
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
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tool_notification_settings (
        groupId TEXT NOT NULL PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 0,
        updatedAt INTEGER NOT NULL
      );
    `);
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
