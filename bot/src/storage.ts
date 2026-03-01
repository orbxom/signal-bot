import Database from 'better-sqlite3';
import { Message } from './types';

interface MessageRow {
  id: number;
  groupId: string;
  sender: string;
  content: string;
  timestamp: number;
  isBot: number;
}

export class Storage {
  private db: Database.Database;
  private closed = false;

  constructor(dbPath: string) {
    try {
      this.db = new Database(dbPath);
      this.initTables();
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes('EACCES')) {
          throw new Error(`Permission denied: Cannot access database at ${dbPath}`);
        } else if (error.message.includes('ENOSPC')) {
          throw new Error('Disk full: Cannot create database');
        } else if (error.message.includes('SQLITE_CORRUPT')) {
          throw new Error(`Database corrupted at ${dbPath}`);
        } else {
          throw new Error(`Failed to initialize database: ${error.message}`);
        }
      }
      throw error;
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
      if (error instanceof Error) {
        if (error.message.includes('SQLITE_BUSY') || error.message.includes('SQLITE_LOCKED')) {
          throw new Error('Database is locked by another process');
        } else {
          throw new Error(`Failed to create tables: ${error.message}`);
        }
      }
      throw error;
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
      const stmt = this.db.prepare(`
        INSERT INTO messages (groupId, sender, content, timestamp, isBot)
        VALUES (?, ?, ?, ?, ?)
      `);
      stmt.run(
        message.groupId,
        message.sender,
        message.content,
        message.timestamp,
        message.isBot ? 1 : 0
      );
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes('SQLITE_BUSY') || error.message.includes('SQLITE_LOCKED')) {
          throw new Error('Database is locked by another process');
        } else if (error.message.includes('ENOSPC')) {
          throw new Error('Disk full: Cannot write message');
        } else {
          throw new Error(`Failed to add message: ${error.message}`);
        }
      }
      throw error;
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
      const stmt = this.db.prepare(`
        SELECT * FROM messages
        WHERE groupId = ?
        ORDER BY timestamp DESC
        LIMIT ?
      `);
      const rows = stmt.all(groupId, limit) as MessageRow[];
      return rows.reverse().map(row => ({
        id: row.id,
        groupId: row.groupId,
        sender: row.sender,
        content: row.content,
        timestamp: row.timestamp,
        isBot: row.isBot === 1
      }));
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes('SQLITE_BUSY') || error.message.includes('SQLITE_LOCKED')) {
          throw new Error('Database is locked by another process');
        } else {
          throw new Error(`Failed to retrieve messages: ${error.message}`);
        }
      }
      throw error;
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
      this.db.prepare(`
        DELETE FROM messages
        WHERE groupId = ?
        AND id NOT IN (
          SELECT id FROM messages
          WHERE groupId = ?
          ORDER BY timestamp DESC
          LIMIT ?
        )
      `).run(groupId, groupId, keepCount);
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes('SQLITE_BUSY') || error.message.includes('SQLITE_LOCKED')) {
          throw new Error('Database is locked by another process');
        } else if (error.message.includes('ENOSPC')) {
          throw new Error('Disk full: Cannot trim messages');
        } else {
          throw new Error(`Failed to trim messages: ${error.message}`);
        }
      }
      throw error;
    }
  }

  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
}
