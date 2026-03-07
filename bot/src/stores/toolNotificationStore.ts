import type Database from 'better-sqlite3';
import type { DatabaseConnection } from '../db';

export class ToolNotificationStore {
  private conn: DatabaseConnection;
  private stmts: {
    get: Database.Statement;
    upsert: Database.Statement;
  };

  constructor(conn: DatabaseConnection) {
    this.conn = conn;
    this.stmts = {
      get: conn.db.prepare(`
        SELECT enabled FROM tool_notification_settings WHERE groupId = ?
      `),
      upsert: conn.db.prepare(`
        INSERT INTO tool_notification_settings (groupId, enabled, updatedAt)
        VALUES (?, ?, ?)
        ON CONFLICT(groupId) DO UPDATE SET
          enabled = excluded.enabled,
          updatedAt = excluded.updatedAt
      `),
    };
  }

  isEnabled(groupId: string): boolean {
    return this.conn.runOp('get tool notification setting', () => {
      const row = this.stmts.get.get(groupId) as { enabled: number } | undefined;
      return row ? row.enabled === 1 : false;
    });
  }

  setEnabled(groupId: string, enabled: boolean): void {
    this.conn.runOp('set tool notification setting', () => {
      this.stmts.upsert.run(groupId, enabled ? 1 : 0, Date.now());
    });
  }
}
