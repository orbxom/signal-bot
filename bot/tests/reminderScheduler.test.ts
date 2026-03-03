import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReminderScheduler } from '../src/reminderScheduler';
import type { Reminder } from '../src/types';

function makeReminder(overrides: Partial<Reminder> = {}): Reminder {
  return {
    id: 1,
    groupId: 'group1',
    requester: '+61400000000',
    reminderText: 'Test reminder',
    dueAt: Date.now() - 1000, // just past due
    status: 'pending',
    retryCount: 0,
    createdAt: Date.now() - 60000,
    sentAt: null,
    ...overrides,
  };
}

describe('ReminderScheduler', () => {
  let mockStorage: {
    getDueReminders: ReturnType<typeof vi.fn>;
    markReminderSent: ReturnType<typeof vi.fn>;
    markReminderFailed: ReturnType<typeof vi.fn>;
    incrementReminderRetry: ReturnType<typeof vi.fn>;
  };
  let mockSignalClient: {
    sendMessage: ReturnType<typeof vi.fn>;
  };
  let scheduler: ReminderScheduler;

  beforeEach(() => {
    mockStorage = {
      getDueReminders: vi.fn().mockReturnValue([]),
      markReminderSent: vi.fn(),
      markReminderFailed: vi.fn(),
      incrementReminderRetry: vi.fn(),
    };
    mockSignalClient = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
    };
    scheduler = new ReminderScheduler(mockStorage as any, mockSignalClient as any);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  describe('processDueReminders', () => {
    it('should return 0 when no due reminders exist', async () => {
      mockStorage.getDueReminders.mockReturnValue([]);

      const count = await scheduler.processDueReminders();

      expect(count).toBe(0);
      expect(mockSignalClient.sendMessage).not.toHaveBeenCalled();
    });

    it('should send a single reminder successfully and return 1', async () => {
      const reminder = makeReminder();
      mockStorage.getDueReminders.mockReturnValue([reminder]);

      const count = await scheduler.processDueReminders();

      expect(count).toBe(1);
      expect(mockSignalClient.sendMessage).toHaveBeenCalledTimes(1);
      expect(mockSignalClient.sendMessage).toHaveBeenCalledWith('group1', expect.stringContaining('Test reminder'));
      expect(mockStorage.markReminderSent).toHaveBeenCalledWith(1);
    });

    it('should process multiple reminders and return correct count', async () => {
      const reminders = [
        makeReminder({ id: 1, reminderText: 'First' }),
        makeReminder({ id: 2, reminderText: 'Second' }),
        makeReminder({ id: 3, reminderText: 'Third' }),
      ];
      mockStorage.getDueReminders.mockReturnValue(reminders);

      const count = await scheduler.processDueReminders();

      expect(count).toBe(3);
      expect(mockSignalClient.sendMessage).toHaveBeenCalledTimes(3);
      expect(mockStorage.markReminderSent).toHaveBeenCalledTimes(3);
    });

    it('should return 0 when send fails on first attempt', async () => {
      const reminder = makeReminder();
      mockStorage.getDueReminders.mockReturnValue([reminder]);
      mockSignalClient.sendMessage.mockRejectedValue(new Error('Network error'));

      const count = await scheduler.processDueReminders();

      expect(count).toBe(0);
      expect(mockStorage.incrementReminderRetry).toHaveBeenCalledWith(1);
      expect(mockStorage.markReminderSent).not.toHaveBeenCalled();
    });

    it('should mark reminder as failed when retryCount >= MAX_RETRIES', async () => {
      const reminder = makeReminder({ retryCount: 3 });
      mockStorage.getDueReminders.mockReturnValue([reminder]);

      const count = await scheduler.processDueReminders();

      expect(count).toBe(0);
      expect(mockStorage.markReminderFailed).toHaveBeenCalledWith(1);
      expect(mockSignalClient.sendMessage).not.toHaveBeenCalled();
    });

    it('should mark stale reminder (>24h overdue) as failed', async () => {
      const now = Date.now();
      const twentyFiveHoursAgo = now - 25 * 60 * 60 * 1000;
      const reminder = makeReminder({ dueAt: twentyFiveHoursAgo });
      mockStorage.getDueReminders.mockReturnValue([reminder]);

      const count = await scheduler.processDueReminders();

      expect(count).toBe(0);
      expect(mockStorage.markReminderFailed).toHaveBeenCalledWith(1);
      expect(mockSignalClient.sendMessage).not.toHaveBeenCalled();
    });

    it('should handle mixed batch with some successes and some failures', async () => {
      const reminders = [
        makeReminder({ id: 1, reminderText: 'Success 1' }),
        makeReminder({ id: 2, reminderText: 'Fail', retryCount: 3 }), // max retries
        makeReminder({ id: 3, reminderText: 'Success 2' }),
      ];
      mockStorage.getDueReminders.mockReturnValue(reminders);

      const count = await scheduler.processDueReminders();

      expect(count).toBe(2);
      expect(mockSignalClient.sendMessage).toHaveBeenCalledTimes(2);
      expect(mockStorage.markReminderSent).toHaveBeenCalledTimes(2);
      expect(mockStorage.markReminderFailed).toHaveBeenCalledWith(2);
    });

    it('should log when reminders are processed', async () => {
      const reminder = makeReminder();
      mockStorage.getDueReminders.mockReturnValue([reminder]);

      await scheduler.processDueReminders();

      expect(console.log).toHaveBeenCalledWith('Processed 1 reminder(s)');
    });

    it('should not log when no reminders are processed', async () => {
      mockStorage.getDueReminders.mockReturnValue([]);

      await scheduler.processDueReminders();

      expect(console.log).not.toHaveBeenCalled();
    });
  });

  describe('message formatting', () => {
    it('should start with reminder emoji and contain reminder text', async () => {
      const reminder = makeReminder({ reminderText: 'Buy groceries' });
      mockStorage.getDueReminders.mockReturnValue([reminder]);

      await scheduler.processDueReminders();

      const sentMessage = mockSignalClient.sendMessage.mock.calls[0][1];
      expect(sentMessage).toMatch(/^⏰ Reminder: Buy groceries/);
    });

    it('should not include lateness annotation for on-time reminders', async () => {
      const reminder = makeReminder({ dueAt: Date.now() - 1000 }); // 1 second ago
      mockStorage.getDueReminders.mockReturnValue([reminder]);

      await scheduler.processDueReminders();

      const sentMessage = mockSignalClient.sendMessage.mock.calls[0][1];
      expect(sentMessage).toBe('\u23F0 Reminder: Test reminder');
      expect(sentMessage).not.toContain('late');
    });

    it('should include minutes late annotation for 5-60 minute delay', async () => {
      const now = Date.now();
      const tenMinutesAgo = now - 10 * 60 * 1000;
      const reminder = makeReminder({ dueAt: tenMinutesAgo });
      mockStorage.getDueReminders.mockReturnValue([reminder]);

      await scheduler.processDueReminders();

      const sentMessage = mockSignalClient.sendMessage.mock.calls[0][1];
      expect(sentMessage).toContain('(10 minutes late)');
    });

    it('should include hours late annotation for 1-24h delay', async () => {
      const now = Date.now();
      const threeHoursAgo = now - 3 * 60 * 60 * 1000;
      const reminder = makeReminder({ dueAt: threeHoursAgo });
      mockStorage.getDueReminders.mockReturnValue([reminder]);

      await scheduler.processDueReminders();

      const sentMessage = mockSignalClient.sendMessage.mock.calls[0][1];
      expect(sentMessage).toContain('(3 hours late)');
    });

    it('should use singular "hour" for 1 hour late', async () => {
      const now = Date.now();
      const oneHourAgo = now - 60 * 60 * 1000;
      const reminder = makeReminder({ dueAt: oneHourAgo });
      mockStorage.getDueReminders.mockReturnValue([reminder]);

      await scheduler.processDueReminders();

      const sentMessage = mockSignalClient.sendMessage.mock.calls[0][1];
      expect(sentMessage).toContain('(1 hour late)');
      expect(sentMessage).not.toContain('hours');
    });

    it('should not include lateness for exactly 5 minutes', async () => {
      const now = Date.now();
      const fiveMinutesAgo = now - 5 * 60 * 1000;
      const reminder = makeReminder({ dueAt: fiveMinutesAgo });
      mockStorage.getDueReminders.mockReturnValue([reminder]);

      await scheduler.processDueReminders();

      const sentMessage = mockSignalClient.sendMessage.mock.calls[0][1];
      expect(sentMessage).not.toContain('late');
    });
  });

  describe('error handling', () => {
    it('should increment retry on send failure without marking as failed', async () => {
      const reminder = makeReminder({ retryCount: 1 });
      mockStorage.getDueReminders.mockReturnValue([reminder]);
      mockSignalClient.sendMessage.mockRejectedValue(new Error('Connection refused'));

      await scheduler.processDueReminders();

      expect(mockStorage.incrementReminderRetry).toHaveBeenCalledWith(1);
      expect(mockStorage.markReminderFailed).not.toHaveBeenCalled();
      expect(mockStorage.markReminderSent).not.toHaveBeenCalled();
    });

    it('should log error on send failure', async () => {
      const reminder = makeReminder();
      mockStorage.getDueReminders.mockReturnValue([reminder]);
      const error = new Error('Connection refused');
      mockSignalClient.sendMessage.mockRejectedValue(error);

      await scheduler.processDueReminders();

      expect(console.error).toHaveBeenCalledWith('Failed to send reminder 1:', error);
    });

    it('should warn when marking stale reminder as failed', async () => {
      const now = Date.now();
      const reminder = makeReminder({ dueAt: now - 25 * 60 * 60 * 1000 });
      mockStorage.getDueReminders.mockReturnValue([reminder]);

      await scheduler.processDueReminders();

      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('overdue, marking as failed'));
    });

    it('should warn when marking max-retry reminder as failed', async () => {
      const reminder = makeReminder({ retryCount: 3 });
      mockStorage.getDueReminders.mockReturnValue([reminder]);

      await scheduler.processDueReminders();

      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('exceeded max retries'));
    });

    it('should continue processing remaining reminders after one fails to send', async () => {
      const reminders = [
        makeReminder({ id: 1, reminderText: 'Fails' }),
        makeReminder({ id: 2, reminderText: 'Succeeds' }),
      ];
      mockStorage.getDueReminders.mockReturnValue(reminders);
      mockSignalClient.sendMessage.mockRejectedValueOnce(new Error('Failed')).mockResolvedValueOnce(undefined);

      const count = await scheduler.processDueReminders();

      expect(count).toBe(1);
      expect(mockStorage.incrementReminderRetry).toHaveBeenCalledWith(1);
      expect(mockStorage.markReminderSent).toHaveBeenCalledWith(2);
    });
  });
});
