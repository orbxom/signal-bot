import type Database from 'better-sqlite3';
import type { DatabaseConnection } from '../db';
import { wrapSqliteError } from '../db';
import type { RecurringReminder, RecurringReminderStatus } from '../types';

export const IN_FLIGHT_TIMEOUT_MS = 7 * 60 * 1000; // 7 minutes — must exceed Claude CLI 5min timeout
export const MAX_CONSECUTIVE_FAILURES = 5;

const STATUS = {
  active: 'active',
  cancelled: 'cancelled',
} as const satisfies Record<string, RecurringReminderStatus>;

type RecurringReminderRow = Omit<RecurringReminder, 'status'> & { status: string };

function mapRow(row: RecurringReminderRow): RecurringReminder {
  return { ...row, status: row.status as RecurringReminderStatus };
}

export class RecurringReminderStore {
  private conn: DatabaseConnection;
  private stmts: {
    insert: Database.Statement;
    getGroupsWithDue: Database.Statement;
    getDueByGroup: Database.Statement;
    markInFlight: Database.Statement;
    markFired: Database.Statement;
    clearInFlight: Database.Statement;
    cancel: Database.Statement;
    listActive: Database.Statement;
    incrementFailures: Database.Statement;
    advanceNextDue: Database.Statement;
    getById: Database.Statement;
  };

  constructor(conn: DatabaseConnection) {
    this.conn = conn;
    this.stmts = {
      insert: conn.db.prepare(`
        INSERT INTO recurring_reminders (groupId, requester, promptText, cronExpression, timezone, nextDueAt, status, consecutiveFailures, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, '${STATUS.active}', 0, ?, ?)
      `),
      getGroupsWithDue: conn.db.prepare(`
        SELECT DISTINCT groupId FROM recurring_reminders
        WHERE status = '${STATUS.active}' AND nextDueAt <= ?
          AND (lastInFlightAt IS NULL OR lastInFlightAt < ?)
      `),
      getDueByGroup: conn.db.prepare(`
        SELECT * FROM recurring_reminders
        WHERE groupId = ? AND status = '${STATUS.active}' AND nextDueAt <= ?
          AND (lastInFlightAt IS NULL OR lastInFlightAt < ?)
        ORDER BY nextDueAt ASC
        LIMIT ?
      `),
      markInFlight: conn.db.prepare(`
        UPDATE recurring_reminders SET lastInFlightAt = ?, updatedAt = ?
        WHERE id = ? AND (lastInFlightAt IS NULL OR lastInFlightAt < ?)
      `),
      markFired: conn.db.prepare(`
        UPDATE recurring_reminders SET lastFiredAt = ?, lastInFlightAt = NULL, nextDueAt = ?, consecutiveFailures = 0, updatedAt = ?
        WHERE id = ?
      `),
      clearInFlight: conn.db.prepare(`
        UPDATE recurring_reminders SET lastInFlightAt = NULL, updatedAt = ?
        WHERE id = ?
      `),
      cancel: conn.db.prepare(`
        UPDATE recurring_reminders SET status = '${STATUS.cancelled}', updatedAt = ?
        WHERE id = ? AND groupId = ? AND status != '${STATUS.cancelled}'
      `),
      listActive: conn.db.prepare(`
        SELECT * FROM recurring_reminders
        WHERE groupId = ? AND status != '${STATUS.cancelled}'
        ORDER BY nextDueAt ASC
      `),
      incrementFailures: conn.db.prepare(`
        UPDATE recurring_reminders SET consecutiveFailures = consecutiveFailures + 1, updatedAt = ?
        WHERE id = ?
      `),
      advanceNextDue: conn.db.prepare(`
        UPDATE recurring_reminders SET nextDueAt = ?, lastInFlightAt = NULL, updatedAt = ?
        WHERE id = ?
      `),
      getById: conn.db.prepare(`
        SELECT * FROM recurring_reminders WHERE id = ?
      `),
    };
  }

  create(
    groupId: string,
    requester: string,
    promptText: string,
    cronExpression: string,
    timezone: string,
    nextDueAt: number,
  ): number {
    this.conn.ensureOpen();
    if (!groupId || groupId.trim() === '') {
      throw new Error('Invalid groupId: cannot be empty');
    }
    if (!promptText || promptText.trim() === '') {
      throw new Error('Invalid promptText: cannot be empty');
    }

    try {
      const now = Date.now();
      const result = this.stmts.insert.run(
        groupId,
        requester,
        promptText,
        cronExpression,
        timezone,
        nextDueAt,
        now,
        now,
      );
      return Number(result.lastInsertRowid);
    } catch (error) {
      wrapSqliteError(error, 'create recurring reminder');
    }
  }

  getGroupsWithDue(now: number): string[] {
    return this.conn.runOp('get groups with due recurring reminders', () => {
      const cutoff = now - IN_FLIGHT_TIMEOUT_MS;
      const rows = this.stmts.getGroupsWithDue.all(now, cutoff) as Array<{ groupId: string }>;
      return rows.map(r => r.groupId);
    });
  }

  getDueByGroup(groupId: string, now: number, limit: number): RecurringReminder[] {
    return this.conn.runOp('get due recurring reminders by group', () => {
      const cutoff = now - IN_FLIGHT_TIMEOUT_MS;
      const rows = this.stmts.getDueByGroup.all(groupId, now, cutoff, limit) as Array<RecurringReminderRow>;
      return rows.map(mapRow);
    });
  }

  markInFlight(id: number): boolean {
    return this.conn.runOp('mark recurring reminder in-flight', () => {
      const now = Date.now();
      const cutoff = now - IN_FLIGHT_TIMEOUT_MS;
      const result = this.stmts.markInFlight.run(now, now, id, cutoff);
      return result.changes > 0;
    });
  }

  markFired(id: number, nextDueAt: number): boolean {
    return this.conn.runOp('mark recurring reminder fired', () => {
      const now = Date.now();
      const result = this.stmts.markFired.run(now, nextDueAt, now, id);
      return result.changes > 0;
    });
  }

  clearInFlight(id: number): void {
    this.conn.runOp('clear recurring reminder in-flight', () => {
      this.stmts.clearInFlight.run(Date.now(), id);
    });
  }

  cancel(id: number, groupId: string): boolean {
    return this.conn.runOp('cancel recurring reminder', () => {
      const result = this.stmts.cancel.run(Date.now(), id, groupId);
      return result.changes > 0;
    });
  }

  listActive(groupId: string): RecurringReminder[] {
    return this.conn.runOp('list active recurring reminders', () => {
      const rows = this.stmts.listActive.all(groupId) as Array<RecurringReminderRow>;
      return rows.map(mapRow);
    });
  }

  incrementFailures(id: number): number {
    return this.conn.runOp('increment recurring reminder failures', () => {
      this.stmts.incrementFailures.run(Date.now(), id);
      const row = this.stmts.getById.get(id) as RecurringReminderRow | undefined;
      return row?.consecutiveFailures ?? 0;
    });
  }

  advanceNextDue(id: number, nextDueAt: number): void {
    this.conn.runOp('advance recurring reminder next due', () => {
      this.stmts.advanceNextDue.run(nextDueAt, Date.now(), id);
    });
  }
}
