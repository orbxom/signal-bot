import type Database from 'better-sqlite3';
import type { DatabaseConnection } from '../db';
import { wrapSqliteError } from '../db';
import type { Attachment } from '../types';

export class AttachmentStore {
  private conn: DatabaseConnection;
  private stmts: {
    upsert: Database.Statement;
    get: Database.Statement;
    trim: Database.Statement;
  };

  constructor(conn: DatabaseConnection) {
    this.conn = conn;
    this.stmts = {
      upsert: conn.db.prepare(`
        INSERT INTO attachment_data (id, groupId, sender, contentType, size, filename, data, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET data = excluded.data
      `),
      get: conn.db.prepare('SELECT * FROM attachment_data WHERE id = ?'),
      trim: conn.db.prepare('DELETE FROM attachment_data WHERE timestamp < ?'),
    };
  }

  save(attachment: Attachment): void {
    this.conn.ensureOpen();
    try {
      this.stmts.upsert.run(
        attachment.id,
        attachment.groupId,
        attachment.sender,
        attachment.contentType,
        attachment.size,
        attachment.filename,
        attachment.data,
        attachment.timestamp,
      );
    } catch (error) {
      wrapSqliteError(error, 'save attachment');
    }
  }

  get(id: string): Attachment | null {
    this.conn.ensureOpen();
    try {
      return (this.stmts.get.get(id) as Attachment) ?? null;
    } catch (error) {
      wrapSqliteError(error, 'get attachment');
    }
  }

  trimOlderThan(cutoffTimestamp: number): void {
    this.conn.ensureOpen();
    try {
      this.stmts.trim.run(cutoffTimestamp);
    } catch (error) {
      wrapSqliteError(error, 'trim attachments');
    }
  }
}
