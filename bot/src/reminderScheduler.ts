import { logger } from './logger';
import type { RecurringReminderExecutor } from './recurringReminderExecutor';
import type { SignalClient } from './signalClient';
import { MAX_CONSECUTIVE_FAILURES, type RecurringReminderStore } from './stores/recurringReminderStore';
import type { ReminderStore } from './stores/reminderStore';
import type { RecurringReminder, Reminder } from './types';
import { computeNextDue } from './utils/cron';

const MAX_RETRIES = 3;
const MAX_STALENESS_MS = 24 * 60 * 60 * 1000; // 24 hours
const PER_GROUP_LIMIT = 20;
const BASE_BACKOFF_MS = 60_000; // 60 seconds

export class ReminderScheduler {
  constructor(
    private reminderStore: ReminderStore,
    private signalClient: SignalClient,
    private recurringStore?: RecurringReminderStore,
    private recurringExecutor?: RecurringReminderExecutor,
  ) {}

  async processDueReminders(): Promise<number> {
    const now = Date.now();
    const groups = this.reminderStore.getGroupsWithDueReminders(now);
    let total = 0;
    for (const groupId of groups) {
      total += await this.processGroupReminders(groupId, now);
    }
    if (this.recurringStore && this.recurringExecutor) {
      try {
        total += await this.processRecurringReminders(now);
      } catch (error) {
        logger.error('Error processing recurring reminders:', error);
      }
    }

    return total;
  }

  private async processRecurringReminders(now: number): Promise<number> {
    const store = this.recurringStore as RecurringReminderStore;
    const executor = this.recurringExecutor as RecurringReminderExecutor;
    const groups = store.getGroupsWithDue(now);
    let total = 0;

    for (const groupId of groups) {
      const reminders = store.getDueByGroup(groupId, now, 1);
      for (const reminder of reminders) {
        try {
          const claimed = store.markInFlight(reminder.id);
          if (!claimed) continue;

          await executor.execute(reminder);

          const nextDueAt = computeNextDue(reminder.cronExpression, reminder.timezone);
          store.markFired(reminder.id, nextDueAt);
          total++;
        } catch (error) {
          logger.error(`Failed to execute recurring reminder ${reminder.id}:`, error);
          await this.handleRecurringFailure(reminder);
        }
      }
    }

    return total;
  }

  private async handleRecurringFailure(reminder: RecurringReminder): Promise<void> {
    const store = this.recurringStore as RecurringReminderStore;

    const nextDueAt = computeNextDue(reminder.cronExpression, reminder.timezone);
    store.advanceNextDue(reminder.id, nextDueAt);

    const failures = store.incrementFailures(reminder.id);
    if (failures >= MAX_CONSECUTIVE_FAILURES) {
      store.cancel(reminder.id, reminder.groupId);
      try {
        const msg = `⚠️ Recurring reminder auto-cancelled after ${failures} consecutive failures: "${reminder.promptText}". It was set by ${reminder.requester}.`;
        await this.signalClient.sendMessage(reminder.groupId, msg);
      } catch {
        logger.error(`Failed to send auto-cancel notification for recurring reminder ${reminder.id}`);
      }
    }
  }

  private async processGroupReminders(groupId: string, now: number): Promise<number> {
    const reminders = this.reminderStore.getDueByGroup(groupId, now, PER_GROUP_LIMIT);
    let sentCount = 0;
    for (const reminder of reminders) {
      try {
        const result = await this.processReminder(reminder, now);
        if (result) sentCount++;
      } catch (error) {
        logger.error(`Unexpected error processing reminder ${reminder.id}:`, error);
      }
    }
    return sentCount;
  }

  private async processReminder(reminder: Reminder, now: number): Promise<boolean> {
    const staleness = now - reminder.dueAt;

    // Stale check (>24h overdue)
    if (staleness > MAX_STALENESS_MS) {
      const reason = 'Reminder is more than 24 hours overdue';
      this.reminderStore.markFailed(reminder.id, reason);
      await this.sendFailureNotification(reminder, 'too far overdue');
      return false;
    }

    // Max retries check
    if (reminder.retryCount >= MAX_RETRIES) {
      const reason = 'Exceeded maximum retry attempts';
      this.reminderStore.markFailed(reminder.id, reason);
      await this.sendFailureNotification(reminder, 'exceeded maximum retries');
      return false;
    }

    // Exponential backoff check
    if (reminder.lastAttemptAt !== null && reminder.retryCount > 0) {
      const backoff = BASE_BACKOFF_MS * 2 ** (reminder.retryCount - 1);
      if (now - reminder.lastAttemptAt < backoff) {
        return false; // Skip, still within backoff window
      }
    }

    // Claim-then-send: record attempt BEFORE sending
    this.reminderStore.recordAttempt(reminder.id);

    const messageText = this.formatReminderMessage(reminder, staleness);
    try {
      await this.signalClient.sendMessage(reminder.groupId, messageText);
      this.reminderStore.markSent(reminder.id);
      return true;
    } catch (error) {
      logger.error(`Failed to send reminder ${reminder.id}:`, error);
      // Don't mark failed — recordAttempt already incremented retryCount
      // Will retry on next cycle (with backoff)
      return false;
    }
  }

  private async sendFailureNotification(reminder: Reminder, reason: string): Promise<void> {
    try {
      const msg = `\u26A0\uFE0F A reminder could not be delivered: "${reminder.reminderText}". It was set by ${reminder.requester}. Reason: ${reason}.`;
      await this.signalClient.sendMessage(reminder.groupId, msg);
    } catch {
      logger.error(`Failed to send failure notification for reminder ${reminder.id}`);
    }
  }

  private formatReminderMessage(reminder: Reminder, stalenessMs: number): string {
    let message = `\u23F0 Reminder: ${reminder.reminderText}`;
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
