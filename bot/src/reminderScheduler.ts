import type { SignalClient } from './signalClient';
import type { Storage } from './storage';
import type { Reminder } from './types';

const MAX_RETRIES = 3;
const MAX_STALENESS_MS = 24 * 60 * 60 * 1000; // 24 hours
const BATCH_LIMIT = 50;

export class ReminderScheduler {
  private storage: Storage;
  private signalClient: SignalClient;

  constructor(storage: Storage, signalClient: SignalClient) {
    this.storage = storage;
    this.signalClient = signalClient;
  }

  async processDueReminders(): Promise<number> {
    const now = Date.now();
    const reminders = this.storage.getDueReminders(now, BATCH_LIMIT);
    let sentCount = 0;

    for (const reminder of reminders) {
      const success = await this.processReminder(reminder, now);
      if (success) {
        sentCount++;
      }
    }

    if (sentCount > 0) {
      console.log(`Processed ${sentCount} reminder(s)`);
    }

    return sentCount;
  }

  private async processReminder(reminder: Reminder, now: number): Promise<boolean> {
    const staleness = now - reminder.dueAt;

    // If >24h overdue, mark failed (stale)
    if (staleness > MAX_STALENESS_MS) {
      console.warn(`Reminder ${reminder.id} is ${Math.round(staleness / 3600000)}h overdue, marking as failed`);
      this.storage.markReminderFailed(reminder.id);
      return false;
    }

    // If retryCount >= MAX_RETRIES, mark failed
    if (reminder.retryCount >= MAX_RETRIES) {
      console.warn(`Reminder ${reminder.id} exceeded max retries (${MAX_RETRIES}), marking as failed`);
      this.storage.markReminderFailed(reminder.id);
      return false;
    }

    // Format message
    const messageText = this.formatReminderMessage(reminder, staleness);

    try {
      await this.signalClient.sendMessage(reminder.groupId, messageText);
      this.storage.markReminderSent(reminder.id);
      return true;
    } catch (error) {
      console.error(`Failed to send reminder ${reminder.id}:`, error);
      this.storage.incrementReminderRetry(reminder.id);
      return false;
    }
  }

  private formatReminderMessage(reminder: Reminder, stalenessMs: number): string {
    let message = `\u23F0 Reminder: ${reminder.reminderText}`;

    // If significantly late (>5 min), add note
    if (stalenessMs > 5 * 60 * 1000) {
      const minutesLate = Math.round(stalenessMs / 60000);
      if (minutesLate < 60) {
        message += `\n(${minutesLate} minutes late)`;
      } else {
        const hoursLate = Math.round(minutesLate / 60);
        message += `\n(${hoursLate} hour${hoursLate > 1 ? 's' : ''} late)`;
      }
    }

    return message;
  }
}
