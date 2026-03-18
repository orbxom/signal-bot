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

  listMetadata(filters?: { groupId?: string; limit?: number; offset?: number }): Omit<Attachment, 'data'>[] {
    this.conn.ensureOpen();
    try {
      const limit = Math.min(filters?.limit ?? 50, 200);
      const offset = filters?.offset ?? 0;
      if (filters?.groupId) {
        return this.conn.db.prepare(
          'SELECT id, groupId, sender, contentType, size, filename, timestamp FROM attachment_data WHERE groupId = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?'
        ).all(filters.groupId, limit, offset) as Omit<Attachment, 'data'>[];
      }
      return this.conn.db.prepare(
        'SELECT id, groupId, sender, contentType, size, filename, timestamp FROM attachment_data ORDER BY timestamp DESC LIMIT ? OFFSET ?'
      ).all(limit, offset) as Omit<Attachment, 'data'>[];
    } catch (error) {
      wrapSqliteError(error, 'list attachment metadata');
    }
  }

  getStats(): { totalSize: number; countByGroup: Array<{ groupId: string; count: number; size: number }> } {
    this.conn.ensureOpen();
    try {
      const rows = this.conn.db.prepare(
        'SELECT groupId, COUNT(*) as count, SUM(LENGTH(data)) as size FROM attachment_data GROUP BY groupId'
      ).all() as Array<{ groupId: string; count: number; size: number }>;
      const totalSize = rows.reduce((sum, r) => sum + (r.size || 0), 0);
      return { totalSize, countByGroup: rows };
    } catch (error) {
      wrapSqliteError(error, 'get attachment stats');
    }
  }

  deleteById(id: string): boolean {
    this.conn.ensureOpen();
    try {
      const result = this.conn.db.prepare('DELETE FROM attachment_data WHERE id = ?').run(id);
      return result.changes > 0;
    } catch (error) {
      wrapSqliteError(error, 'delete attachment');
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
