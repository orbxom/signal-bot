import Database from 'better-sqlite3';
import type { Message } from './types';

function wrapSqliteError(error: unknown, operation: string): never {
  if (error instanceof Error) {
    if (error.message.includes('SQLITE_BUSY') || error.message.includes('SQLITE_LOCKED')) {
      throw new Error('Database is locked by another process');
    } else if (error.message.includes('ENOSPC')) {
      throw new Error(`Disk full: Cannot ${operation}`);
    } else if (error.message.includes('SQLITE_CORRUPT')) {
      throw new Error(`Database corrupted`);
    }
    throw new Error(`Failed to ${operation}: ${error.message}`);
  }
  throw error;
}

export class Storage {
  private db: Database.Database;
  private closed = false;
  private stmts: {
    insert: Database.Statement;
    selectRecent: Database.Statement;
    trim: Database.Statement;
  };

  constructor(dbPath: string) {
    try {
      this.db = new Database(dbPath);
      this.initTables();
      this.stmts = {
        insert: this.db.prepare(`
          INSERT INTO messages (groupId, sender, content, timestamp, isBot)
          VALUES (?, ?, ?, ?, ?)
        `),
        selectRecent: this.db.prepare(`
          SELECT * FROM messages
          WHERE groupId = ?
          ORDER BY timestamp DESC
          LIMIT ?
        `),
        trim: this.db.prepare(`
          DELETE FROM messages
          WHERE groupId = ?
          AND id NOT IN (
            SELECT id FROM messages
            WHERE groupId = ?
            ORDER BY timestamp DESC
            LIMIT ?
          )
        `),
      };
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
          isBot INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_group_timestamp
        ON messages(groupId, timestamp DESC);
      `);
    } catch (error) {
      wrapSqliteError(error, 'create tables');
    }
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new Error('Database is closed');
    }
  }

  addMessage(message: Omit<Message, 'id'>): void {
    this.ensureOpen();
    if (!message.groupId || message.groupId.trim() === '') {
      throw new Error('Invalid groupId: cannot be empty');
    }

    try {
      this.stmts.insert.run(message.groupId, message.sender, message.content, message.timestamp, message.isBot ? 1 : 0);
    } catch (error) {
      wrapSqliteError(error, 'add message');
    }
  }

  getRecentMessages(groupId: string, limit: number): Message[] {
    this.ensureOpen();
    if (!groupId || groupId.trim() === '') {
      throw new Error('Invalid groupId: cannot be empty');
    }
    if (limit <= 0) {
      throw new Error('Invalid limit: must be greater than zero');
    }

    try {
      const rows = this.stmts.selectRecent.all(groupId, limit) as Array<{
        id: number;
        groupId: string;
        sender: string;
        content: string;
        timestamp: number;
        isBot: number;
      }>;
      return rows.reverse().map(row => ({
        id: row.id,
        groupId: row.groupId,
        sender: row.sender,
        content: row.content,
        timestamp: row.timestamp,
        isBot: row.isBot === 1,
      }));
    } catch (error) {
      wrapSqliteError(error, 'retrieve messages');
    }
  }

  trimMessages(groupId: string, keepCount: number): void {
    this.ensureOpen();
    if (!groupId || groupId.trim() === '') {
      throw new Error('Invalid groupId: cannot be empty');
    }
    if (keepCount <= 0) {
      throw new Error('Invalid keepCount: must be greater than zero');
    }

    try {
      this.stmts.trim.run(groupId, groupId, keepCount);
    } catch (error) {
      wrapSqliteError(error, 'trim messages');
    }
  }

  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
}
