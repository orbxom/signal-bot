import type { Storage } from '../../../bot/src/storage';
import type { WebSocketHub } from '../websocket';

export class DbPoller {
  private interval: ReturnType<typeof setInterval> | null = null;
  private lastMessageRowid = 0;
  private lastReminderSentRowid = 0;
  private lastReminderFailedRowid = 0;

  constructor(
    private storage: Storage,
    private wsHub: WebSocketHub,
  ) {}

  start(): void {
    this.initHighWaterMarks();
    this.interval = setInterval(() => this.poll(), 2500);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private initHighWaterMarks(): void {
    try {
      const maxMsg = this.storage.conn.db.prepare(
        'SELECT MAX(rowid) as maxId FROM messages',
      ).get() as { maxId: number | null } | undefined;
      this.lastMessageRowid = maxMsg?.maxId ?? 0;

      const maxSent = this.storage.conn.db.prepare(
        'SELECT MAX(rowid) as maxId FROM reminders WHERE status = ?',
      ).get('sent') as { maxId: number | null } | undefined;
      this.lastReminderSentRowid = maxSent?.maxId ?? 0;

      const maxFailed = this.storage.conn.db.prepare(
        'SELECT MAX(rowid) as maxId FROM reminders WHERE status = ?',
      ).get('failed') as { maxId: number | null } | undefined;
      this.lastReminderFailedRowid = maxFailed?.maxId ?? 0;
    } catch {
      // DB not ready yet
    }
  }

  private poll(): void {
    try {
      this.pollMessages();
      this.pollReminders();
    } catch {
      // Silently handle polling errors
    }
  }

  private pollMessages(): void {
    const rows = this.storage.conn.db.prepare(
      'SELECT rowid, groupId, sender, content, timestamp, isBot FROM messages WHERE rowid > ? ORDER BY rowid LIMIT 50',
    ).all(this.lastMessageRowid) as Array<{
      rowid: number; groupId: string; sender: string; content: string; timestamp: number; isBot: number;
    }>;

    for (const row of rows) {
      this.wsHub.broadcast({
        type: 'message:new',
        data: {
          groupId: row.groupId,
          sender: row.sender,
          preview: row.content?.substring(0, 100) ?? '',
          timestamp: row.timestamp,
          isBot: row.isBot === 1,
        },
      });
      this.lastMessageRowid = row.rowid;
    }
  }

  private pollReminders(): void {
    const sent = this.storage.conn.db.prepare(
      'SELECT rowid, id, groupId, reminderText FROM reminders WHERE status = ? AND rowid > ? ORDER BY rowid LIMIT 20',
    ).all('sent', this.lastReminderSentRowid) as Array<{
      rowid: number; id: number; groupId: string; reminderText: string;
    }>;

    for (const row of sent) {
      this.wsHub.broadcast({
        type: 'reminder:due',
        data: { id: row.id, groupId: row.groupId, text: row.reminderText },
      });
      this.lastReminderSentRowid = row.rowid;
    }

    const failed = this.storage.conn.db.prepare(
      'SELECT rowid, id, retryCount, failureReason FROM reminders WHERE status = ? AND rowid > ? ORDER BY rowid LIMIT 20',
    ).all('failed', this.lastReminderFailedRowid) as Array<{
      rowid: number; id: number; retryCount: number; failureReason: string;
    }>;

    for (const row of failed) {
      this.wsHub.broadcast({
        type: 'reminder:failed',
        data: { id: row.id, retryCount: row.retryCount, error: row.failureReason },
      });
      this.lastReminderFailedRowid = row.rowid;
    }
  }
}
