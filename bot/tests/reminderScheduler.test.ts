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
    lastAttemptAt: null,
    failureReason: null,
    ...overrides,
  };
}

function createMockStore() {
  return {
    getGroupsWithDueReminders: vi.fn().mockReturnValue([]),
    getDueByGroup: vi.fn().mockReturnValue([]),
    recordAttempt: vi.fn(),
    markSent: vi.fn().mockReturnValue(true),
    markFailed: vi.fn().mockReturnValue(true),
    create: vi.fn(),
    cancel: vi.fn(),
    listPending: vi.fn(),
  };
}

function createMockSignalClient() {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
  };
}

describe('ReminderScheduler', () => {
  let mockStore: ReturnType<typeof createMockStore>;
  let mockSignalClient: ReturnType<typeof createMockSignalClient>;
  let scheduler: ReminderScheduler;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockStore = createMockStore();
    mockSignalClient = createMockSignalClient();
    scheduler = new ReminderScheduler(mockStore as any, mockSignalClient as any);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  describe('per-group processing', () => {
    it('should call getGroupsWithDueReminders(now)', async () => {
      await scheduler.processDueReminders();
      expect(mockStore.getGroupsWithDueReminders).toHaveBeenCalledWith(expect.any(Number));
    });

    it('should call getDueByGroup for each group', async () => {
      mockStore.getGroupsWithDueReminders.mockReturnValue(['groupA', 'groupB']);
      mockStore.getDueByGroup.mockReturnValue([]);

      await scheduler.processDueReminders();

      expect(mockStore.getDueByGroup).toHaveBeenCalledWith('groupA', expect.any(Number), 20);
      expect(mockStore.getDueByGroup).toHaveBeenCalledWith('groupB', expect.any(Number), 20);
    });

    it('should return total count of sent reminders across all groups', async () => {
      mockStore.getGroupsWithDueReminders.mockReturnValue(['groupA', 'groupB']);
      mockStore.getDueByGroup
        .mockReturnValueOnce([makeReminder({ id: 1, groupId: 'groupA' })])
        .mockReturnValueOnce([makeReminder({ id: 2, groupId: 'groupB' }), makeReminder({ id: 3, groupId: 'groupB' })]);

      const count = await scheduler.processDueReminders();

      expect(count).toBe(3);
    });

    it('should return 0 when groups array is empty', async () => {
      mockStore.getGroupsWithDueReminders.mockReturnValue([]);

      const count = await scheduler.processDueReminders();

      expect(count).toBe(0);
      expect(mockStore.getDueByGroup).not.toHaveBeenCalled();
    });

    it('should process each group independently', async () => {
      mockStore.getGroupsWithDueReminders.mockReturnValue(['groupA', 'groupB']);
      const reminderA = makeReminder({ id: 1, groupId: 'groupA' });
      const reminderB = makeReminder({ id: 2, groupId: 'groupB' });
      mockStore.getDueByGroup.mockReturnValueOnce([reminderA]).mockReturnValueOnce([reminderB]);

      // Make first group's send fail
      mockSignalClient.sendMessage.mockRejectedValueOnce(new Error('fail')).mockResolvedValueOnce(undefined);

      const count = await scheduler.processDueReminders();

      expect(count).toBe(1);
      // Both groups were still processed
      expect(mockStore.recordAttempt).toHaveBeenCalledTimes(2);
    });
  });

  describe('claim-then-send pattern', () => {
    it('should call recordAttempt before sendMessage', async () => {
      const reminder = makeReminder();
      mockStore.getGroupsWithDueReminders.mockReturnValue(['group1']);
      mockStore.getDueByGroup.mockReturnValue([reminder]);

      const callOrder: string[] = [];
      mockStore.recordAttempt.mockImplementation(() => {
        callOrder.push('recordAttempt');
      });
      mockSignalClient.sendMessage.mockImplementation(async () => {
        callOrder.push('sendMessage');
      });

      await scheduler.processDueReminders();

      expect(callOrder).toEqual(['recordAttempt', 'sendMessage']);
    });

    it('should call markSent on successful send', async () => {
      const reminder = makeReminder({ id: 42 });
      mockStore.getGroupsWithDueReminders.mockReturnValue(['group1']);
      mockStore.getDueByGroup.mockReturnValue([reminder]);

      await scheduler.processDueReminders();

      expect(mockStore.markSent).toHaveBeenCalledWith(42);
    });

    it('should not error when markSent returns false (already handled)', async () => {
      const reminder = makeReminder({ id: 42 });
      mockStore.getGroupsWithDueReminders.mockReturnValue(['group1']);
      mockStore.getDueByGroup.mockReturnValue([reminder]);
      mockStore.markSent.mockReturnValue(false);

      const count = await scheduler.processDueReminders();

      expect(count).toBe(1); // Still counts as sent from the scheduler's perspective
    });

    it('should not call markFailed on send failure', async () => {
      const reminder = makeReminder();
      mockStore.getGroupsWithDueReminders.mockReturnValue(['group1']);
      mockStore.getDueByGroup.mockReturnValue([reminder]);
      mockSignalClient.sendMessage.mockRejectedValue(new Error('Network error'));

      await scheduler.processDueReminders();

      expect(mockStore.markFailed).not.toHaveBeenCalled();
      expect(mockStore.recordAttempt).toHaveBeenCalledWith(1);
    });
  });

  describe('exponential backoff', () => {
    it('should skip reminder when within backoff period (retryCount=1, <60s)', async () => {
      const now = Date.now();
      const reminder = makeReminder({
        retryCount: 1,
        lastAttemptAt: now - 30_000, // 30s ago, backoff is 60s
      });
      mockStore.getGroupsWithDueReminders.mockReturnValue(['group1']);
      mockStore.getDueByGroup.mockReturnValue([reminder]);

      const count = await scheduler.processDueReminders();

      expect(count).toBe(0);
      expect(mockStore.recordAttempt).not.toHaveBeenCalled();
      expect(mockSignalClient.sendMessage).not.toHaveBeenCalled();
    });

    it('should skip reminder when within backoff period (retryCount=2, <120s)', async () => {
      const now = Date.now();
      const reminder = makeReminder({
        retryCount: 2,
        lastAttemptAt: now - 90_000, // 90s ago, backoff is 120s
      });
      mockStore.getGroupsWithDueReminders.mockReturnValue(['group1']);
      mockStore.getDueByGroup.mockReturnValue([reminder]);

      const count = await scheduler.processDueReminders();

      expect(count).toBe(0);
      expect(mockStore.recordAttempt).not.toHaveBeenCalled();
    });

    it('should mark failed when retryCount >= MAX_RETRIES (3)', async () => {
      const reminder = makeReminder({
        retryCount: 3,
        lastAttemptAt: Date.now() - 300_000,
      });
      mockStore.getGroupsWithDueReminders.mockReturnValue(['group1']);
      mockStore.getDueByGroup.mockReturnValue([reminder]);

      const count = await scheduler.processDueReminders();

      expect(count).toBe(0);
      expect(mockStore.markFailed).toHaveBeenCalledWith(1, 'Exceeded maximum retry attempts');
    });

    it('should process reminder when backoff period has elapsed', async () => {
      const now = Date.now();
      const reminder = makeReminder({
        retryCount: 1,
        lastAttemptAt: now - 70_000, // 70s ago, backoff is 60s
      });
      mockStore.getGroupsWithDueReminders.mockReturnValue(['group1']);
      mockStore.getDueByGroup.mockReturnValue([reminder]);

      const count = await scheduler.processDueReminders();

      expect(count).toBe(1);
      expect(mockStore.recordAttempt).toHaveBeenCalled();
    });

    it('should always process first attempt (lastAttemptAt is null)', async () => {
      const reminder = makeReminder({
        retryCount: 0,
        lastAttemptAt: null,
      });
      mockStore.getGroupsWithDueReminders.mockReturnValue(['group1']);
      mockStore.getDueByGroup.mockReturnValue([reminder]);

      const count = await scheduler.processDueReminders();

      expect(count).toBe(1);
      expect(mockStore.recordAttempt).toHaveBeenCalled();
    });
  });

  describe('stale reminders (>24h overdue)', () => {
    it('should mark as failed with overdue reason', async () => {
      const now = Date.now();
      const reminder = makeReminder({
        dueAt: now - 25 * 60 * 60 * 1000, // 25h ago
      });
      mockStore.getGroupsWithDueReminders.mockReturnValue(['group1']);
      mockStore.getDueByGroup.mockReturnValue([reminder]);

      await scheduler.processDueReminders();

      expect(mockStore.markFailed).toHaveBeenCalledWith(1, 'Reminder is more than 24 hours overdue');
    });

    it('should send notification to group about failed reminder', async () => {
      const now = Date.now();
      const reminder = makeReminder({
        dueAt: now - 25 * 60 * 60 * 1000,
        reminderText: 'Buy milk',
        requester: '+61400111222',
      });
      mockStore.getGroupsWithDueReminders.mockReturnValue(['group1']);
      mockStore.getDueByGroup.mockReturnValue([reminder]);

      await scheduler.processDueReminders();

      expect(mockSignalClient.sendMessage).toHaveBeenCalledWith('group1', expect.stringContaining('Buy milk'));
      expect(mockSignalClient.sendMessage).toHaveBeenCalledWith('group1', expect.stringContaining('+61400111222'));
      expect(mockSignalClient.sendMessage).toHaveBeenCalledWith('group1', expect.stringContaining('too far overdue'));
    });

    it('should catch and log notification failure without throwing', async () => {
      const now = Date.now();
      const reminder = makeReminder({
        dueAt: now - 25 * 60 * 60 * 1000,
      });
      mockStore.getGroupsWithDueReminders.mockReturnValue(['group1']);
      mockStore.getDueByGroup.mockReturnValue([reminder]);
      mockSignalClient.sendMessage.mockRejectedValue(new Error('Network down'));

      // Should not throw
      const count = await scheduler.processDueReminders();

      expect(count).toBe(0);
      expect(mockStore.markFailed).toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Failed to send failure notification'));
    });
  });

  describe('max retries exceeded', () => {
    it('should mark as failed with max retries reason', async () => {
      const reminder = makeReminder({
        retryCount: 3,
        lastAttemptAt: Date.now() - 300_000,
      });
      mockStore.getGroupsWithDueReminders.mockReturnValue(['group1']);
      mockStore.getDueByGroup.mockReturnValue([reminder]);

      await scheduler.processDueReminders();

      expect(mockStore.markFailed).toHaveBeenCalledWith(1, 'Exceeded maximum retry attempts');
    });

    it('should send notification to group about max retries', async () => {
      const reminder = makeReminder({
        retryCount: 3,
        lastAttemptAt: Date.now() - 300_000,
        reminderText: 'Call dentist',
        requester: '+61400333444',
      });
      mockStore.getGroupsWithDueReminders.mockReturnValue(['group1']);
      mockStore.getDueByGroup.mockReturnValue([reminder]);

      await scheduler.processDueReminders();

      expect(mockSignalClient.sendMessage).toHaveBeenCalledWith('group1', expect.stringContaining('Call dentist'));
      expect(mockSignalClient.sendMessage).toHaveBeenCalledWith(
        'group1',
        expect.stringContaining('exceeded maximum retries'),
      );
    });

    it('should catch notification failure without throwing', async () => {
      const reminder = makeReminder({
        retryCount: 3,
        lastAttemptAt: Date.now() - 300_000,
      });
      mockStore.getGroupsWithDueReminders.mockReturnValue(['group1']);
      mockStore.getDueByGroup.mockReturnValue([reminder]);
      mockSignalClient.sendMessage.mockRejectedValue(new Error('fail'));

      const count = await scheduler.processDueReminders();

      expect(count).toBe(0);
      expect(mockStore.markFailed).toHaveBeenCalled();
    });
  });

  describe('message formatting', () => {
    it('should format normal reminder with emoji and text', async () => {
      const reminder = makeReminder({ reminderText: 'Buy groceries', dueAt: Date.now() - 1000 });
      mockStore.getGroupsWithDueReminders.mockReturnValue(['group1']);
      mockStore.getDueByGroup.mockReturnValue([reminder]);

      await scheduler.processDueReminders();

      const sentMessage = mockSignalClient.sendMessage.mock.calls[0][1];
      expect(sentMessage).toBe('\u23F0 Reminder: Buy groceries');
    });

    it('should include minutes late for >5 minute delay', async () => {
      const now = Date.now();
      const reminder = makeReminder({ dueAt: now - 10 * 60 * 1000 }); // 10 min ago
      mockStore.getGroupsWithDueReminders.mockReturnValue(['group1']);
      mockStore.getDueByGroup.mockReturnValue([reminder]);

      await scheduler.processDueReminders();

      const sentMessage = mockSignalClient.sendMessage.mock.calls[0][1];
      expect(sentMessage).toContain('(10 minutes late)');
    });

    it('should include hours late for >= 60 minute delay', async () => {
      const now = Date.now();
      const reminder = makeReminder({ dueAt: now - 3 * 60 * 60 * 1000 }); // 3h ago
      mockStore.getGroupsWithDueReminders.mockReturnValue(['group1']);
      mockStore.getDueByGroup.mockReturnValue([reminder]);

      await scheduler.processDueReminders();

      const sentMessage = mockSignalClient.sendMessage.mock.calls[0][1];
      expect(sentMessage).toContain('(3 hours late)');
    });

    it('should not include lateness for <= 5 minutes', async () => {
      const reminder = makeReminder({ dueAt: Date.now() - 1000 }); // 1s ago
      mockStore.getGroupsWithDueReminders.mockReturnValue(['group1']);
      mockStore.getDueByGroup.mockReturnValue([reminder]);

      await scheduler.processDueReminders();

      const sentMessage = mockSignalClient.sendMessage.mock.calls[0][1];
      expect(sentMessage).not.toContain('late');
    });
  });

  describe('error resilience', () => {
    it('should continue processing after individual reminder failure', async () => {
      const reminders = [
        makeReminder({ id: 1, reminderText: 'First' }),
        makeReminder({ id: 2, reminderText: 'Second' }),
      ];
      mockStore.getGroupsWithDueReminders.mockReturnValue(['group1']);
      mockStore.getDueByGroup.mockReturnValue(reminders);
      mockSignalClient.sendMessage.mockRejectedValueOnce(new Error('fail')).mockResolvedValueOnce(undefined);

      const count = await scheduler.processDueReminders();

      expect(count).toBe(1);
      expect(mockStore.recordAttempt).toHaveBeenCalledTimes(2);
      expect(mockStore.markSent).toHaveBeenCalledWith(2);
    });

    it('should not propagate Signal API error on notification', async () => {
      const now = Date.now();
      // Two stale reminders — both notifications will fail
      const reminders = [
        makeReminder({ id: 1, dueAt: now - 25 * 60 * 60 * 1000 }),
        makeReminder({ id: 2, dueAt: now - 26 * 60 * 60 * 1000 }),
      ];
      mockStore.getGroupsWithDueReminders.mockReturnValue(['group1']);
      mockStore.getDueByGroup.mockReturnValue(reminders);
      mockSignalClient.sendMessage.mockRejectedValue(new Error('API down'));

      // Should not throw
      const count = await scheduler.processDueReminders();

      expect(count).toBe(0);
      // Both were still marked failed
      expect(mockStore.markFailed).toHaveBeenCalledTimes(2);
    });
  });
});
