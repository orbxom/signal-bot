import Database from 'better-sqlite3';
import { estimateTokens } from './mcpServerBase';
import type { Dossier, Message, Reminder, ReminderStatus } from './types';

export const DOSSIER_TOKEN_LIMIT = 1000;

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
    searchMessages: Database.Statement;
    searchMessagesWithSender: Database.Statement;
    getMessagesByDateRange: Database.Statement;
    insertReminder: Database.Statement;
    selectDueReminders: Database.Statement;
    markReminderSent: Database.Statement;
    markReminderFailed: Database.Statement;
    incrementReminderRetry: Database.Statement;
    cancelReminder: Database.Statement;
    listReminders: Database.Statement;
    upsertDossier: Database.Statement;
    getDossier: Database.Statement;
    getDossiersByGroup: Database.Statement;
    deleteDossier: Database.Statement;
    getDistinctGroupIds: Database.Statement;
  };

  constructor(dbPath: string) {
    try {
      this.db = new Database(dbPath);
      this.db.pragma('journal_mode = WAL');
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
        searchMessages: this.db.prepare(`
          SELECT * FROM messages
          WHERE groupId = ?
            AND content LIKE ? ESCAPE '\\'
            AND timestamp >= ?
            AND timestamp <= ?
          ORDER BY timestamp ASC
          LIMIT ?
        `),
        searchMessagesWithSender: this.db.prepare(`
          SELECT * FROM messages
          WHERE groupId = ?
            AND content LIKE ? ESCAPE '\\'
            AND sender = ?
            AND timestamp >= ?
            AND timestamp <= ?
          ORDER BY timestamp ASC
          LIMIT ?
        `),
        getMessagesByDateRange: this.db.prepare(`
          SELECT * FROM messages
          WHERE groupId = ?
            AND timestamp >= ?
            AND timestamp <= ?
          ORDER BY timestamp ASC
          LIMIT ?
        `),
        insertReminder: this.db.prepare(`
          INSERT INTO reminders (groupId, requester, reminderText, dueAt, status, retryCount, createdAt)
          VALUES (?, ?, ?, ?, 'pending', 0, ?)
        `),
        selectDueReminders: this.db.prepare(`
          SELECT * FROM reminders
          WHERE status = 'pending' AND dueAt <= ?
          ORDER BY dueAt ASC
          LIMIT ?
        `),
        markReminderSent: this.db.prepare(`
          UPDATE reminders SET status = 'sent', sentAt = ? WHERE id = ? AND status = 'pending'
        `),
        markReminderFailed: this.db.prepare(`
          UPDATE reminders SET status = 'failed' WHERE id = ? AND status = 'pending'
        `),
        incrementReminderRetry: this.db.prepare(`
          UPDATE reminders SET retryCount = retryCount + 1 WHERE id = ?
        `),
        cancelReminder: this.db.prepare(`
          UPDATE reminders SET status = 'cancelled' WHERE id = ? AND groupId = ? AND status = 'pending'
        `),
        listReminders: this.db.prepare(`
          SELECT * FROM reminders
          WHERE groupId = ? AND status = 'pending'
          ORDER BY dueAt ASC
        `),
        upsertDossier: this.db.prepare(`
          INSERT INTO dossiers (groupId, personId, displayName, notes, createdAt, updatedAt)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(groupId, personId) DO UPDATE SET
            displayName = excluded.displayName,
            notes = excluded.notes,
            updatedAt = excluded.updatedAt
          RETURNING *
        `),
        getDossier: this.db.prepare(`
          SELECT * FROM dossiers WHERE groupId = ? AND personId = ?
        `),
        getDossiersByGroup: this.db.prepare(`
          SELECT * FROM dossiers WHERE groupId = ? ORDER BY displayName ASC
        `),
        deleteDossier: this.db.prepare(`
          DELETE FROM dossiers WHERE groupId = ? AND personId = ?
        `),
        getDistinctGroupIds: this.db.prepare(`
          SELECT DISTINCT groupId FROM messages
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

  getDistinctGroupIds(): string[] {
    this.ensureOpen();

    try {
      const rows = this.stmts.getDistinctGroupIds.all() as Array<{ groupId: string }>;
      return rows.map(row => row.groupId);
    } catch (error) {
      wrapSqliteError(error, 'get distinct group IDs');
    }
  }

  searchMessages(
    groupId: string,
    keyword: string,
    options?: { sender?: string; startTimestamp?: number; endTimestamp?: number; limit?: number },
  ): Message[] {
    this.ensureOpen();
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

      const rows = stmt.all(...params) as Array<{
        id: number;
        groupId: string;
        sender: string;
        content: string;
        timestamp: number;
        isBot: number;
      }>;
      return rows.map(row => ({
        id: row.id,
        groupId: row.groupId,
        sender: row.sender,
        content: row.content,
        timestamp: row.timestamp,
        isBot: row.isBot === 1,
      }));
    } catch (error) {
      wrapSqliteError(error, 'search messages');
    }
  }

  getMessagesByDateRange(groupId: string, startTs: number, endTs: number, limit?: number): Message[] {
    this.ensureOpen();
    if (!groupId || groupId.trim() === '') {
      throw new Error('Invalid groupId: cannot be empty');
    }

    const effectiveLimit = limit ?? 200;
    if (effectiveLimit <= 0) {
      throw new Error('Invalid limit: must be greater than zero');
    }

    try {
      const rows = this.stmts.getMessagesByDateRange.all(groupId, startTs, endTs, effectiveLimit) as Array<{
        id: number;
        groupId: string;
        sender: string;
        content: string;
        timestamp: number;
        isBot: number;
      }>;
      return rows.map(row => ({
        id: row.id,
        groupId: row.groupId,
        sender: row.sender,
        content: row.content,
        timestamp: row.timestamp,
        isBot: row.isBot === 1,
      }));
    } catch (error) {
      wrapSqliteError(error, 'get messages by date range');
    }
  }

  createReminder(groupId: string, requester: string, reminderText: string, dueAt: number): number {
    this.ensureOpen();
    if (!groupId || groupId.trim() === '') {
      throw new Error('Invalid groupId: cannot be empty');
    }
    if (!reminderText || reminderText.trim() === '') {
      throw new Error('Invalid reminderText: cannot be empty');
    }

    try {
      const result = this.stmts.insertReminder.run(groupId, requester, reminderText, dueAt, Date.now());
      return Number(result.lastInsertRowid);
    } catch (error) {
      wrapSqliteError(error, 'create reminder');
    }
  }

  getDueReminders(now?: number, limit: number = 50): Reminder[] {
    this.ensureOpen();

    try {
      const rows = this.stmts.selectDueReminders.all(now ?? Date.now(), limit) as Array<ReminderRow>;
      return rows.map(mapReminderRow);
    } catch (error) {
      wrapSqliteError(error, 'get due reminders');
    }
  }

  markReminderSent(id: number): boolean {
    this.ensureOpen();

    try {
      const result = this.stmts.markReminderSent.run(Date.now(), id);
      return result.changes > 0;
    } catch (error) {
      wrapSqliteError(error, 'mark reminder sent');
    }
  }

  markReminderFailed(id: number): boolean {
    this.ensureOpen();

    try {
      const result = this.stmts.markReminderFailed.run(id);
      return result.changes > 0;
    } catch (error) {
      wrapSqliteError(error, 'mark reminder failed');
    }
  }

  incrementReminderRetry(id: number): void {
    this.ensureOpen();

    try {
      this.stmts.incrementReminderRetry.run(id);
    } catch (error) {
      wrapSqliteError(error, 'increment reminder retry');
    }
  }

  cancelReminder(id: number, groupId: string): boolean {
    this.ensureOpen();

    try {
      const result = this.stmts.cancelReminder.run(id, groupId);
      return result.changes > 0;
    } catch (error) {
      wrapSqliteError(error, 'cancel reminder');
    }
  }

  listReminders(groupId: string): Reminder[] {
    this.ensureOpen();
    if (!groupId || groupId.trim() === '') {
      throw new Error('Invalid groupId: cannot be empty');
    }

    try {
      const rows = this.stmts.listReminders.all(groupId) as Array<ReminderRow>;
      return rows.map(mapReminderRow);
    } catch (error) {
      wrapSqliteError(error, 'list reminders');
    }
  }

  upsertDossier(groupId: string, personId: string, displayName: string, notes: string): Dossier {
    this.ensureOpen();
    if (!groupId || groupId.trim() === '') {
      throw new Error('Invalid groupId: cannot be empty');
    }
    if (!personId || personId.trim() === '') {
      throw new Error('Invalid personId: cannot be empty');
    }
    if (estimateTokens(notes) > DOSSIER_TOKEN_LIMIT) {
      throw new Error(`Notes exceeds token limit of ${DOSSIER_TOKEN_LIMIT} tokens`);
    }

    try {
      const now = Date.now();
      const row = this.stmts.upsertDossier.get(groupId, personId, displayName, notes, now, now) as Dossier;
      return row;
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.startsWith('Invalid ') || error.message.startsWith('Notes exceeds'))
      ) {
        throw error;
      }
      wrapSqliteError(error, 'upsert dossier');
    }
  }

  getDossier(groupId: string, personId: string): Dossier | null {
    this.ensureOpen();

    try {
      const row = this.stmts.getDossier.get(groupId, personId) as Dossier | undefined;
      return row ?? null;
    } catch (error) {
      wrapSqliteError(error, 'get dossier');
    }
  }

  getDossiersByGroup(groupId: string): Dossier[] {
    this.ensureOpen();
    if (!groupId || groupId.trim() === '') {
      throw new Error('Invalid groupId: cannot be empty');
    }

    try {
      return this.stmts.getDossiersByGroup.all(groupId) as Dossier[];
    } catch (error) {
      wrapSqliteError(error, 'get dossiers by group');
    }
  }

  deleteDossier(groupId: string, personId: string): boolean {
    this.ensureOpen();

    try {
      const result = this.stmts.deleteDossier.run(groupId, personId);
      return result.changes > 0;
    } catch (error) {
      wrapSqliteError(error, 'delete dossier');
    }
  }

  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
}

type ReminderRow = Omit<Reminder, 'status'> & { status: string };

function mapReminderRow(row: ReminderRow): Reminder {
  return { ...row, status: row.status as ReminderStatus };
}
