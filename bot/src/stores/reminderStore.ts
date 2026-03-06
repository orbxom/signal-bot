import type Database from 'better-sqlite3';
import type { DatabaseConnection } from '../db';
import { wrapSqliteError } from '../db';
import type { Reminder, ReminderStatus } from '../types';

const STATUS = {
  pending: 'pending',
  sent: 'sent',
  failed: 'failed',
  cancelled: 'cancelled',
} as const satisfies Record<string, ReminderStatus>;

type ReminderRow = Omit<Reminder, 'status'> & { status: string };

function mapReminderRow(row: ReminderRow): Reminder {
  return { ...row, status: row.status as ReminderStatus };
}

export class ReminderStore {
  private conn: DatabaseConnection;
  private stmts: {
    insert: Database.Statement;
    getDueByGroup: Database.Statement;
    getGroupsWithDueReminders: Database.Statement;
    markSent: Database.Statement;
    markFailed: Database.Statement;
    recordAttempt: Database.Statement;
    cancel: Database.Statement;
    listPending: Database.Statement;
    selectDueReminders: Database.Statement;
    incrementRetry: Database.Statement;
  };

  constructor(conn: DatabaseConnection) {
    this.conn = conn;
    this.stmts = {
      insert: conn.db.prepare(`
        INSERT INTO reminders (groupId, requester, reminderText, dueAt, status, retryCount, createdAt)
        VALUES (?, ?, ?, ?, '${STATUS.pending}', 0, ?)
      `),
      getDueByGroup: conn.db.prepare(`
        SELECT * FROM reminders
        WHERE groupId = ? AND status = '${STATUS.pending}' AND dueAt <= ?
        ORDER BY dueAt ASC
        LIMIT ?
      `),
      getGroupsWithDueReminders: conn.db.prepare(`
        SELECT DISTINCT groupId FROM reminders
        WHERE status = '${STATUS.pending}' AND dueAt <= ?
      `),
      markSent: conn.db.prepare(`
        UPDATE reminders SET status = '${STATUS.sent}', sentAt = ? WHERE id = ? AND status = '${STATUS.pending}'
      `),
      markFailed: conn.db.prepare(`
        UPDATE reminders SET status = '${STATUS.failed}', failureReason = ? WHERE id = ? AND status = '${STATUS.pending}'
      `),
      recordAttempt: conn.db.prepare(`
        UPDATE reminders SET lastAttemptAt = ?, retryCount = retryCount + 1 WHERE id = ?
      `),
      cancel: conn.db.prepare(`
        UPDATE reminders SET status = '${STATUS.cancelled}' WHERE id = ? AND groupId = ? AND status = '${STATUS.pending}'
      `),
      listPending: conn.db.prepare(`
        SELECT * FROM reminders
        WHERE groupId = ? AND status = '${STATUS.pending}'
        ORDER BY dueAt ASC
      `),
      // Legacy compat: due reminders without group filter
      selectDueReminders: conn.db.prepare(`
        SELECT * FROM reminders
        WHERE status = '${STATUS.pending}' AND dueAt <= ?
        ORDER BY dueAt ASC
        LIMIT ?
      `),
      // Legacy compat: increment retry without setting lastAttemptAt
      incrementRetry: conn.db.prepare(`
        UPDATE reminders SET retryCount = retryCount + 1 WHERE id = ?
      `),
    };
  }

  create(groupId: string, requester: string, reminderText: string, dueAt: number): number {
    this.conn.ensureOpen();
    if (!groupId || groupId.trim() === '') {
      throw new Error('Invalid groupId: cannot be empty');
    }
    if (!reminderText || reminderText.trim() === '') {
      throw new Error('Invalid reminderText: cannot be empty');
    }

    try {
      const result = this.stmts.insert.run(groupId, requester, reminderText, dueAt, Date.now());
      return Number(result.lastInsertRowid);
    } catch (error) {
      wrapSqliteError(error, 'create reminder');
    }
  }

  getDueByGroup(groupId: string, now: number, limit: number): Reminder[] {
    this.conn.ensureOpen();

    try {
      const rows = this.stmts.getDueByGroup.all(groupId, now, limit) as Array<ReminderRow>;
      return rows.map(mapReminderRow);
    } catch (error) {
      wrapSqliteError(error, 'get due reminders by group');
    }
  }

  getGroupsWithDueReminders(now: number): string[] {
    this.conn.ensureOpen();

    try {
      const rows = this.stmts.getGroupsWithDueReminders.all(now) as Array<{ groupId: string }>;
      return rows.map(r => r.groupId);
    } catch (error) {
      wrapSqliteError(error, 'get groups with due reminders');
    }
  }

  markSent(id: number): boolean {
    this.conn.ensureOpen();

    try {
      const result = this.stmts.markSent.run(Date.now(), id);
      return result.changes > 0;
    } catch (error) {
      wrapSqliteError(error, 'mark reminder sent');
    }
  }

  markFailed(id: number, reason: string): boolean {
    this.conn.ensureOpen();

    try {
      const result = this.stmts.markFailed.run(reason, id);
      return result.changes > 0;
    } catch (error) {
      wrapSqliteError(error, 'mark reminder failed');
    }
  }

  recordAttempt(id: number): void {
    this.conn.ensureOpen();

    try {
      this.stmts.recordAttempt.run(Date.now(), id);
    } catch (error) {
      wrapSqliteError(error, 'record attempt');
    }
  }

  cancel(id: number, groupId: string): boolean {
    this.conn.ensureOpen();

    try {
      const result = this.stmts.cancel.run(id, groupId);
      return result.changes > 0;
    } catch (error) {
      wrapSqliteError(error, 'cancel reminder');
    }
  }

  listPending(groupId: string): Reminder[] {
    this.conn.ensureOpen();
    if (!groupId || groupId.trim() === '') {
      throw new Error('Invalid groupId: cannot be empty');
    }

    try {
      const rows = this.stmts.listPending.all(groupId) as Array<ReminderRow>;
      return rows.map(mapReminderRow);
    } catch (error) {
      wrapSqliteError(error, 'list reminders');
    }
  }

  // Legacy compatibility methods (used by existing Storage facade)
  getDueReminders(now?: number, limit = 50): Reminder[] {
    this.conn.ensureOpen();

    try {
      const rows = this.stmts.selectDueReminders.all(now ?? Date.now(), limit) as Array<ReminderRow>;
      return rows.map(mapReminderRow);
    } catch (error) {
      wrapSqliteError(error, 'get due reminders');
    }
  }

  /**
   * Legacy: mark failed without reason (for backward compat with old Storage API)
   */
  markFailedLegacy(id: number): boolean {
    return this.markFailed(id, '');
  }

  /**
   * Legacy: increment retry without setting lastAttemptAt
   */
  incrementRetry(id: number): void {
    this.conn.ensureOpen();

    try {
      this.stmts.incrementRetry.run(id);
    } catch (error) {
      wrapSqliteError(error, 'increment reminder retry');
    }
  }
}
