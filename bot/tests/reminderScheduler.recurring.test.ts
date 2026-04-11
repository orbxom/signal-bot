import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReminderScheduler } from '../src/reminderScheduler';
import type { RecurringReminder, Reminder } from '../src/types';

vi.mock('../src/logger', () => ({
  logger: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    group: vi.fn(),
    step: vi.fn(),
    groupEnd: vi.fn(),
    compact: vi.fn(),
  },
}));

vi.mock('../src/utils/cron', () => ({
  computeNextDue: vi.fn().mockReturnValue(9999999999999),
}));

function makeReminder(overrides: Partial<Reminder> = {}): Reminder {
  return {
    id: 1,
    groupId: 'group1',
    requester: '+61400000000',
    reminderText: 'Test reminder',
    dueAt: Date.now() - 1000,
    status: 'pending',
    retryCount: 0,
    createdAt: Date.now() - 60000,
    sentAt: null,
    lastAttemptAt: null,
    failureReason: null,
    mode: 'simple' as const,
    ...overrides,
  };
}

function makeRecurringReminder(overrides: Partial<RecurringReminder> = {}): RecurringReminder {
  return {
    id: 100,
    groupId: 'group1',
    requester: '+61400000000',
    promptText: 'Daily standup summary',
    cronExpression: '0 9 * * *',
    timezone: 'Australia/Sydney',
    nextDueAt: Date.now() - 1000,
    status: 'active',
    consecutiveFailures: 0,
    lastFiredAt: null,
    lastInFlightAt: null,
    createdAt: Date.now() - 60000,
    updatedAt: Date.now() - 60000,
    ...overrides,
  };
}

function createMockStore() {
  return {
    getGroupsWithDueReminders: vi.fn().mockReturnValue([]),
    getDueByGroup: vi.fn().mockReturnValue([]),
    recordAttempt: vi.fn(),
    markSent: vi.fn().mockReturnValue(true),
    completeReminder: vi.fn().mockReturnValue(true),
    markFailed: vi.fn().mockReturnValue(true),
    create: vi.fn(),
    cancel: vi.fn(),
    listPending: vi.fn(),
  };
}

function createMockRecurringStore() {
  return {
    getGroupsWithDue: vi.fn().mockReturnValue([]),
    getDueByGroup: vi.fn().mockReturnValue([]),
    markInFlight: vi.fn().mockReturnValue(true),
    markFired: vi.fn().mockReturnValue(true),
    clearInFlight: vi.fn(),
    advanceNextDue: vi.fn(),
    cancel: vi.fn().mockReturnValue(true),
    incrementFailures: vi.fn().mockReturnValue(1),
    handleFailure: vi.fn().mockReturnValue(1),
    listActive: vi.fn().mockReturnValue([]),
    create: vi.fn(),
  };
}

function createMockSignalClient() {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockRecurringExecutor() {
  return {
    execute: vi.fn().mockResolvedValue(undefined),
  };
}

describe('ReminderScheduler — recurring reminders', () => {
  let mockStore: ReturnType<typeof createMockStore>;
  let mockSignalClient: ReturnType<typeof createMockSignalClient>;
  let mockRecurringStore: ReturnType<typeof createMockRecurringStore>;
  let mockRecurringExecutor: ReturnType<typeof createMockRecurringExecutor>;
  let scheduler: ReminderScheduler;

  beforeEach(async () => {
    vi.restoreAllMocks();
    const { computeNextDue } = await import('../src/utils/cron');
    (computeNextDue as ReturnType<typeof vi.fn>).mockReturnValue(9999999999999);

    mockStore = createMockStore();
    mockSignalClient = createMockSignalClient();
    mockRecurringStore = createMockRecurringStore();
    mockRecurringExecutor = createMockRecurringExecutor();
    scheduler = new ReminderScheduler(
      mockStore as any,
      mockSignalClient as any,
      mockRecurringStore as any,
      mockRecurringExecutor as any,
    );
  });

  it('processes recurring reminders alongside one-shot reminders', async () => {
    // One-shot reminder
    mockStore.getGroupsWithDueReminders.mockReturnValue(['group1']);
    mockStore.getDueByGroup.mockReturnValue([makeReminder({ id: 1 })]);

    // Recurring reminder
    const recurring = makeRecurringReminder({ id: 100, groupId: 'group1' });
    mockRecurringStore.getGroupsWithDue.mockReturnValue(['group1']);
    mockRecurringStore.getDueByGroup.mockReturnValue([recurring]);

    const count = await scheduler.processDueReminders();

    // One-shot sent + recurring processed
    expect(count).toBe(2);
    expect(mockStore.completeReminder).toHaveBeenCalledWith(1);
    expect(mockRecurringExecutor.execute).toHaveBeenCalledWith(recurring);
    expect(mockRecurringStore.markFired).toHaveBeenCalledWith(100, 9999999999999);
  });

  it('skips recurring reminder if markInFlight returns false (already claimed)', async () => {
    const recurring = makeRecurringReminder({ id: 100 });
    mockRecurringStore.getGroupsWithDue.mockReturnValue(['group1']);
    mockRecurringStore.getDueByGroup.mockReturnValue([recurring]);
    mockRecurringStore.markInFlight.mockReturnValue(false);

    const count = await scheduler.processDueReminders();

    expect(count).toBe(0);
    expect(mockRecurringExecutor.execute).not.toHaveBeenCalled();
    expect(mockRecurringStore.markFired).not.toHaveBeenCalled();
  });

  it('calls handleFailure on executor failure', async () => {
    const { computeNextDue } = await import('../src/utils/cron');
    const recurring = makeRecurringReminder({ id: 100 });
    mockRecurringStore.getGroupsWithDue.mockReturnValue(['group1']);
    mockRecurringStore.getDueByGroup.mockReturnValue([recurring]);
    mockRecurringExecutor.execute.mockRejectedValue(new Error('Claude timeout'));

    const count = await scheduler.processDueReminders();

    expect(count).toBe(0);
    expect(computeNextDue).toHaveBeenCalledWith(recurring.cronExpression, recurring.timezone);
    expect(mockRecurringStore.handleFailure).toHaveBeenCalledWith(100, 9999999999999);
  });

  it('works without recurring dependencies (backward compat)', async () => {
    // Create scheduler WITHOUT recurring deps
    const basicScheduler = new ReminderScheduler(mockStore as any, mockSignalClient as any);

    mockStore.getGroupsWithDueReminders.mockReturnValue(['group1']);
    mockStore.getDueByGroup.mockReturnValue([makeReminder({ id: 1 })]);

    const count = await basicScheduler.processDueReminders();

    expect(count).toBe(1);
    // No recurring processing should have happened
    expect(mockRecurringStore.getGroupsWithDue).not.toHaveBeenCalled();
  });

  it('auto-cancels after 5 consecutive failures', async () => {
    const recurring = makeRecurringReminder({
      id: 100,
      consecutiveFailures: 4, // will become 5 after handleFailure
      promptText: 'Daily weather report',
      requester: '+61400111222',
    });
    mockRecurringStore.getGroupsWithDue.mockReturnValue(['group1']);
    mockRecurringStore.getDueByGroup.mockReturnValue([recurring]);
    mockRecurringExecutor.execute.mockRejectedValue(new Error('fail'));
    mockRecurringStore.handleFailure.mockReturnValue(5);

    const count = await scheduler.processDueReminders();

    expect(count).toBe(0);
    expect(mockRecurringStore.cancel).toHaveBeenCalledWith(100, 'group1');
    expect(mockSignalClient.sendMessage).toHaveBeenCalledWith(
      'group1',
      expect.stringContaining('Daily weather report'),
    );
    expect(mockSignalClient.sendMessage).toHaveBeenCalledWith('group1', expect.stringContaining('auto-cancelled'));
  });

  it('should process multiple due recurring reminders per group', async () => {
    const reminders = [
      makeRecurringReminder({ id: 100, promptText: 'Task 1' }),
      makeRecurringReminder({ id: 101, promptText: 'Task 2' }),
      makeRecurringReminder({ id: 102, promptText: 'Task 3' }),
    ];
    mockRecurringStore.getGroupsWithDue.mockReturnValue(['group1']);
    mockRecurringStore.getDueByGroup.mockReturnValue(reminders);

    const count = await scheduler.processDueReminders();

    expect(count).toBe(3);
    expect(mockRecurringExecutor.execute).toHaveBeenCalledTimes(3);
    expect(mockRecurringStore.markFired).toHaveBeenCalledTimes(3);
  });

  it('should use minimum delay when computeNextDue returns past timestamp', async () => {
    const { computeNextDue } = await import('../src/utils/cron');
    const now = Date.now();
    (computeNextDue as ReturnType<typeof vi.fn>).mockReturnValue(now - 1000);

    const recurring = makeRecurringReminder({ id: 100 });
    mockRecurringStore.getGroupsWithDue.mockReturnValue(['group1']);
    mockRecurringStore.getDueByGroup.mockReturnValue([recurring]);

    await scheduler.processDueReminders();

    // markFired should be called with a future timestamp (now + 60s), not the past value
    const calledWith = mockRecurringStore.markFired.mock.calls[0][1];
    expect(calledWith).toBeGreaterThan(now);
  });

  it('should pass through future timestamps from computeNextDue unchanged', async () => {
    const { computeNextDue } = await import('../src/utils/cron');
    const farFuture = Date.now() + 86400000; // +24h
    (computeNextDue as ReturnType<typeof vi.fn>).mockReturnValue(farFuture);

    const recurring = makeRecurringReminder({ id: 100 });
    mockRecurringStore.getGroupsWithDue.mockReturnValue(['group1']);
    mockRecurringStore.getDueByGroup.mockReturnValue([recurring]);

    await scheduler.processDueReminders();

    expect(mockRecurringStore.markFired).toHaveBeenCalledWith(100, farFuture);
  });

  it('should use minimum delay for past timestamps on failure path too', async () => {
    const { computeNextDue } = await import('../src/utils/cron');
    const now = Date.now();
    (computeNextDue as ReturnType<typeof vi.fn>).mockReturnValue(now - 5000);

    const recurring = makeRecurringReminder({ id: 100 });
    mockRecurringStore.getGroupsWithDue.mockReturnValue(['group1']);
    mockRecurringStore.getDueByGroup.mockReturnValue([recurring]);
    mockRecurringExecutor.execute.mockRejectedValue(new Error('fail'));

    await scheduler.processDueReminders();

    const calledWith = mockRecurringStore.handleFailure.mock.calls[0][1];
    expect(calledWith).toBeGreaterThan(now);
  });
});
