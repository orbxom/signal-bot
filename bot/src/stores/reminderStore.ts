import type Database from 'better-sqlite3';
import type { DatabaseConnection } from '../db';
import { wrapSqliteError } from '../db';
import type { Reminder, ReminderMode, ReminderStatus } from '../types';

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
    completeReminder: Database.Statement;
    markFailed: Database.Statement;
    recordAttempt: Database.Statement;
    cancel: Database.Statement;
    listPending: Database.Statement;
    listAllNoFilter: Database.Statement;
    listAllByGroup: Database.Statement;
    listAllByStatus: Database.Statement;
    listAllByGroupAndStatus: Database.Statement;
  };

  constructor(conn: DatabaseConnection) {
    this.conn = conn;
    this.stmts = {
      insert: conn.db.prepare(`
        INSERT INTO reminders (groupId, requester, reminderText, dueAt, status, retryCount, createdAt, mode)
        VALUES (?, ?, ?, ?, '${STATUS.pending}', 0, ?, ?)
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
      completeReminder: conn.db.prepare(`
        UPDATE reminders SET status = '${STATUS.sent}', sentAt = ?, lastAttemptAt = ?, retryCount = retryCount + 1
        WHERE id = ? AND status = '${STATUS.pending}'
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
      listAllNoFilter: conn.db.prepare('SELECT * FROM reminders ORDER BY dueAt DESC LIMIT ? OFFSET ?'),
      listAllByGroup: conn.db.prepare('SELECT * FROM reminders WHERE groupId = ? ORDER BY dueAt DESC LIMIT ? OFFSET ?'),
      listAllByStatus: conn.db.prepare('SELECT * FROM reminders WHERE status = ? ORDER BY dueAt DESC LIMIT ? OFFSET ?'),
      listAllByGroupAndStatus: conn.db.prepare(
        'SELECT * FROM reminders WHERE groupId = ? AND status = ? ORDER BY dueAt DESC LIMIT ? OFFSET ?',
      ),
    };
  }

  create(
    groupId: string,
    requester: string,
    reminderText: string,
    dueAt: number,
    mode: ReminderMode = 'simple',
  ): number {
    this.conn.ensureOpen();
    if (!groupId || groupId.trim() === '') {
      throw new Error('Invalid groupId: cannot be empty');
    }
    if (!reminderText || reminderText.trim() === '') {
      throw new Error('Invalid reminderText: cannot be empty');
    }

    try {
      const result = this.stmts.insert.run(groupId, requester, reminderText, dueAt, Date.now(), mode);
      return Number(result.lastInsertRowid);
    } catch (error) {
      wrapSqliteError(error, 'create reminder');
    }
  }

  getDueByGroup(groupId: string, now: number, limit: number): Reminder[] {
    return this.conn.runOp('get due reminders by group', () => {
      const rows = this.stmts.getDueByGroup.all(groupId, now, limit) as Array<ReminderRow>;
      return rows.map(mapReminderRow);
    });
  }

  getGroupsWithDueReminders(now: number): string[] {
    return this.conn.runOp('get groups with due reminders', () => {
      const rows = this.stmts.getGroupsWithDueReminders.all(now) as Array<{ groupId: string }>;
      return rows.map(r => r.groupId);
    });
  }

  markSent(id: number): boolean {
    return this.conn.runOp('mark reminder sent', () => {
      const result = this.stmts.markSent.run(Date.now(), id);
      return result.changes > 0;
    });
  }

  completeReminder(id: number): boolean {
    return this.conn.runOp('complete reminder', () => {
      const now = Date.now();
      const result = this.stmts.completeReminder.run(now, now, id);
      return result.changes > 0;
    });
  }

  markFailed(id: number, reason: string): boolean {
    return this.conn.runOp('mark reminder failed', () => {
      const result = this.stmts.markFailed.run(reason, id);
      return result.changes > 0;
    });
  }

  recordAttempt(id: number): void {
    this.conn.runOp('record attempt', () => {
      this.stmts.recordAttempt.run(Date.now(), id);
    });
  }

  cancel(id: number, groupId: string): boolean {
    return this.conn.runOp('cancel reminder', () => {
      const result = this.stmts.cancel.run(id, groupId);
      return result.changes > 0;
    });
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

  listAll(filters?: { groupId?: string; status?: string; limit?: number; offset?: number }): Reminder[] {
    return this.conn.runOp('list all reminders', () => {
      const limit = Math.min(filters?.limit ?? 50, 200);
      const offset = filters?.offset ?? 0;

      let rows: Array<ReminderRow>;
      if (filters?.groupId && filters?.status) {
        rows = this.stmts.listAllByGroupAndStatus.all(
          filters.groupId,
          filters.status,
          limit,
          offset,
        ) as Array<ReminderRow>;
      } else if (filters?.groupId) {
        rows = this.stmts.listAllByGroup.all(filters.groupId, limit, offset) as Array<ReminderRow>;
      } else if (filters?.status) {
        rows = this.stmts.listAllByStatus.all(filters.status, limit, offset) as Array<ReminderRow>;
      } else {
        rows = this.stmts.listAllNoFilter.all(limit, offset) as Array<ReminderRow>;
      }
      return rows.map(mapReminderRow);
    });
  }
}
