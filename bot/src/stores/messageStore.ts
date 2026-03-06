import type Database from 'better-sqlite3';
import type { DatabaseConnection } from '../db';
import { wrapSqliteError } from '../db';
import type { Message, SignalAttachment } from '../types';

type MessageRow = {
  id: number;
  groupId: string;
  sender: string;
  content: string;
  timestamp: number;
  isBot: number;
  attachments: string | null;
};

function mapMessageRow(row: MessageRow): Message {
  const msg: Message = {
    id: row.id,
    groupId: row.groupId,
    sender: row.sender,
    content: row.content,
    timestamp: row.timestamp,
    isBot: row.isBot === 1,
  };
  if (row.attachments) {
    msg.attachments = JSON.parse(row.attachments) as SignalAttachment[];
  }
  return msg;
}

export class MessageStore {
  private conn: DatabaseConnection;
  private stmts: {
    insert: Database.Statement;
    selectRecent: Database.Statement;
    trim: Database.Statement;
    searchMessages: Database.Statement;
    searchMessagesWithSender: Database.Statement;
    getMessagesByDateRange: Database.Statement;
    getDistinctGroupIds: Database.Statement;
  };

  constructor(conn: DatabaseConnection) {
    this.conn = conn;
    this.stmts = {
      insert: conn.db.prepare(`
        INSERT INTO messages (groupId, sender, content, timestamp, isBot, attachments)
        VALUES (?, ?, ?, ?, ?, ?)
      `),
      selectRecent: conn.db.prepare(`
        SELECT * FROM messages
        WHERE groupId = ?
        ORDER BY timestamp DESC
        LIMIT ?
      `),
      trim: conn.db.prepare(`
        DELETE FROM messages
        WHERE groupId = ?
        AND id NOT IN (
          SELECT id FROM messages
          WHERE groupId = ?
          ORDER BY timestamp DESC
          LIMIT ?
        )
      `),
      searchMessages: conn.db.prepare(`
        SELECT * FROM messages
        WHERE groupId = ?
          AND content LIKE ? ESCAPE '\\'
          AND timestamp >= ?
          AND timestamp <= ?
        ORDER BY timestamp ASC
        LIMIT ?
      `),
      searchMessagesWithSender: conn.db.prepare(`
        SELECT * FROM messages
        WHERE groupId = ?
          AND content LIKE ? ESCAPE '\\'
          AND sender = ?
          AND timestamp >= ?
          AND timestamp <= ?
        ORDER BY timestamp ASC
        LIMIT ?
      `),
      getMessagesByDateRange: conn.db.prepare(`
        SELECT * FROM messages
        WHERE groupId = ?
          AND timestamp >= ?
          AND timestamp <= ?
        ORDER BY timestamp ASC
        LIMIT ?
      `),
      getDistinctGroupIds: conn.db.prepare(`
        SELECT DISTINCT groupId FROM messages
      `),
    };
  }

  add(message: Omit<Message, 'id'>): void {
    this.conn.ensureOpen();
    if (!message.groupId || message.groupId.trim() === '') {
      throw new Error('Invalid groupId: cannot be empty');
    }

    try {
      const attachmentsJson = message.attachments?.length ? JSON.stringify(message.attachments) : null;
      this.stmts.insert.run(
        message.groupId,
        message.sender,
        message.content,
        message.timestamp,
        message.isBot ? 1 : 0,
        attachmentsJson,
      );
    } catch (error) {
      wrapSqliteError(error, 'add message');
    }
  }

  getRecent(groupId: string, limit: number): Message[] {
    this.conn.ensureOpen();
    if (!groupId || groupId.trim() === '') {
      throw new Error('Invalid groupId: cannot be empty');
    }
    if (limit <= 0) {
      throw new Error('Invalid limit: must be greater than zero');
    }

    try {
      const rows = this.stmts.selectRecent.all(groupId, limit) as MessageRow[];
      return rows.reverse().map(mapMessageRow);
    } catch (error) {
      wrapSqliteError(error, 'retrieve messages');
    }
  }

  trim(groupId: string, keepCount: number): void {
    this.conn.ensureOpen();
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

  search(
    groupId: string,
    keyword: string,
    options?: { sender?: string; startTimestamp?: number; endTimestamp?: number; limit?: number },
  ): Message[] {
    this.conn.ensureOpen();
    if (!groupId || groupId.trim() === '') {
      throw new Error('Invalid groupId: cannot be empty');
    }
    if (!keyword || keyword.trim() === '') {
      throw new Error('Invalid keyword: cannot be empty');
    }

    const limit = options?.limit ?? 100;
    if (limit <= 0) {
      throw new Error('Invalid limit: must be greater than zero');
    }

    const startTimestamp = options?.startTimestamp ?? 0;
    const endTimestamp = options?.endTimestamp ?? Number.MAX_SAFE_INTEGER;

    // Escape SQL LIKE special characters, then wrap in wildcards
    const escapedKeyword = keyword.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    const pattern = `%${escapedKeyword}%`;

    try {
      const stmt = options?.sender ? this.stmts.searchMessagesWithSender : this.stmts.searchMessages;
      const params = options?.sender
        ? [groupId, pattern, options.sender, startTimestamp, endTimestamp, limit]
        : [groupId, pattern, startTimestamp, endTimestamp, limit];

      const rows = stmt.all(...params) as MessageRow[];
      return rows.map(mapMessageRow);
    } catch (error) {
      wrapSqliteError(error, 'search messages');
    }
  }

  getByDateRange(groupId: string, startTs: number, endTs: number, limit?: number): Message[] {
    this.conn.ensureOpen();
    if (!groupId || groupId.trim() === '') {
      throw new Error('Invalid groupId: cannot be empty');
    }

    const effectiveLimit = limit ?? 200;
    if (effectiveLimit <= 0) {
      throw new Error('Invalid limit: must be greater than zero');
    }

    try {
      const rows = this.stmts.getMessagesByDateRange.all(groupId, startTs, endTs, effectiveLimit) as MessageRow[];
      return rows.map(mapMessageRow);
    } catch (error) {
      wrapSqliteError(error, 'get messages by date range');
    }
  }

  getDistinctGroupIds(): string[] {
    this.conn.ensureOpen();

    try {
      const rows = this.stmts.getDistinctGroupIds.all() as Array<{ groupId: string }>;
      return rows.map(row => row.groupId);
    } catch (error) {
      wrapSqliteError(error, 'get distinct group IDs');
    }
  }
}
