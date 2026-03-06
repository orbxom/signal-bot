import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReminderStore } from '../../src/stores/reminderStore';
import { createTestDb, type TestDb } from '../helpers/testDb';

describe('ReminderStore', () => {
  let db: TestDb;
  let store: ReminderStore;

  const setup = () => {
    db = createTestDb('signal-bot-reminder-store-test-');
    store = new ReminderStore(db.conn);
    return store;
  };

  afterEach(() => {
    db?.cleanup();
  });

  describe('create', () => {
    it('should return auto-incrementing ID', () => {
      setup();
      const id1 = store.create('group1', '+61400000000', 'Task 1', Date.now() + 60000);
      const id2 = store.create('group1', '+61400000000', 'Task 2', Date.now() + 120000);
      expect(id1).toBe(1);
      expect(id2).toBe(2);
    });

    it('should reject empty groupId', () => {
      setup();
      expect(() => store.create('', '+61400000000', 'Test', Date.now() + 60000)).toThrow(
        'Invalid groupId: cannot be empty',
      );
    });

    it('should reject empty reminderText', () => {
      setup();
      expect(() => store.create('group1', '+61400000000', '', Date.now() + 60000)).toThrow(
        'Invalid reminderText: cannot be empty',
      );
    });

    it('should store all fields including createdAt', () => {
      setup();
      const dueAt = Date.now() + 60000;
      const id = store.create('group1', 'Alice', 'Buy milk', dueAt);
      const reminders = store.listPending('group1');
      expect(reminders).toHaveLength(1);
      expect(reminders[0].id).toBe(id);
      expect(reminders[0].groupId).toBe('group1');
      expect(reminders[0].requester).toBe('Alice');
      expect(reminders[0].reminderText).toBe('Buy milk');
      expect(reminders[0].dueAt).toBe(dueAt);
      expect(reminders[0].status).toBe('pending');
      expect(reminders[0].retryCount).toBe(0);
      expect(reminders[0].createdAt).toBeGreaterThan(0);
    });
  });

  describe('getDueByGroup', () => {
    it('should return ONLY that group pending reminders where dueAt <= now', () => {
      setup();
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now - 120000);
      store.create('group1', 'Alice', 'Due reminder', now - 60000);
      store.create('group1', 'Alice', 'Future reminder', now + 60000);
      store.create('group2', 'Bob', 'Other group due', now - 60000);
      vi.restoreAllMocks();

      const reminders = store.getDueByGroup('group1', now, 50);
      expect(reminders).toHaveLength(1);
      expect(reminders[0].reminderText).toBe('Due reminder');
    });

    it('should exclude sent/failed/cancelled reminders', () => {
      setup();
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now - 120000);
      const id1 = store.create('group1', 'Alice', 'Sent', now - 60000);
      const id2 = store.create('group1', 'Alice', 'Failed', now - 50000);
      const id3 = store.create('group1', 'Alice', 'Cancelled', now - 40000);
      store.create('group1', 'Alice', 'Pending', now - 30000);
      vi.restoreAllMocks();

      store.markSent(id1);
      store.markFailed(id2, 'test failure');
      store.cancel(id3, 'group1');

      const reminders = store.getDueByGroup('group1', now, 50);
      expect(reminders).toHaveLength(1);
      expect(reminders[0].reminderText).toBe('Pending');
    });

    it('should respect limit', () => {
      setup();
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now - 120000);
      for (let i = 0; i < 5; i++) {
        store.create('group1', 'Alice', `Reminder ${i}`, now - 60000 + i);
      }
      vi.restoreAllMocks();

      const reminders = store.getDueByGroup('group1', now, 3);
      expect(reminders).toHaveLength(3);
    });

    it('should order by dueAt ASC', () => {
      setup();
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now - 200000);
      store.create('group1', 'Alice', 'Later', now - 30000);
      store.create('group1', 'Alice', 'Earlier', now - 60000);
      vi.restoreAllMocks();

      const reminders = store.getDueByGroup('group1', now, 50);
      expect(reminders[0].reminderText).toBe('Earlier');
      expect(reminders[1].reminderText).toBe('Later');
    });

    it('should return different results for different groups (group isolation)', () => {
      setup();
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now - 120000);
      store.create('group1', 'Alice', 'Group 1 reminder', now - 60000);
      store.create('group2', 'Bob', 'Group 2 reminder', now - 60000);
      vi.restoreAllMocks();

      const group1 = store.getDueByGroup('group1', now, 50);
      const group2 = store.getDueByGroup('group2', now, 50);
      expect(group1).toHaveLength(1);
      expect(group1[0].reminderText).toBe('Group 1 reminder');
      expect(group2).toHaveLength(1);
      expect(group2[0].reminderText).toBe('Group 2 reminder');
    });
  });

  describe('getGroupsWithDueReminders', () => {
    it('should return distinct group IDs', () => {
      setup();
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now - 120000);
      store.create('group1', 'Alice', 'R1', now - 60000);
      store.create('group1', 'Alice', 'R2', now - 50000);
      store.create('group2', 'Bob', 'R3', now - 40000);
      vi.restoreAllMocks();

      const groups = store.getGroupsWithDueReminders(now);
      expect(groups).toHaveLength(2);
      expect(groups).toContain('group1');
      expect(groups).toContain('group2');
    });

    it('should exclude groups with only future reminders', () => {
      setup();
      const now = Date.now();
      store.create('group1', 'Alice', 'Future', now + 60000);

      const groups = store.getGroupsWithDueReminders(now);
      expect(groups).toHaveLength(0);
    });

    it('should return empty when nothing due', () => {
      setup();
      const groups = store.getGroupsWithDueReminders(Date.now());
      expect(groups).toEqual([]);
    });
  });

  describe('markSent', () => {
    it('should transition pending to sent and set sentAt', () => {
      setup();
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now - 120000);
      const id = store.create('group1', 'Alice', 'Test', now - 60000);
      vi.restoreAllMocks();

      const result = store.markSent(id);
      expect(result).toBe(true);

      const reminders = store.getDueByGroup('group1', now, 50);
      expect(reminders).toHaveLength(0);
    });

    it('should return false for already-sent reminder (idempotent)', () => {
      setup();
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now - 120000);
      const id = store.create('group1', 'Alice', 'Test', now - 60000);
      vi.restoreAllMocks();

      store.markSent(id);
      const result = store.markSent(id);
      expect(result).toBe(false);
    });

    it('should return false for non-existent ID', () => {
      setup();
      const result = store.markSent(999);
      expect(result).toBe(false);
    });
  });

  describe('markFailed', () => {
    it('should transition pending to failed and store failureReason', () => {
      setup();
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now - 120000);
      const id = store.create('group1', 'Alice', 'Test', now - 60000);
      vi.restoreAllMocks();

      const result = store.markFailed(id, 'Network error');
      expect(result).toBe(true);

      const reminders = store.getDueByGroup('group1', now, 50);
      expect(reminders).toHaveLength(0);
    });

    it('should return false for non-pending', () => {
      setup();
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now - 120000);
      const id = store.create('group1', 'Alice', 'Test', now - 60000);
      vi.restoreAllMocks();

      store.markSent(id);
      const result = store.markFailed(id, 'Too late');
      expect(result).toBe(false);
    });
  });

  describe('recordAttempt', () => {
    it('should increment retryCount and set lastAttemptAt', () => {
      setup();
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now - 120000);
      const id = store.create('group1', 'Alice', 'Test', now - 60000);
      vi.restoreAllMocks();

      store.recordAttempt(id);
      const reminders = store.getDueByGroup('group1', now, 50);
      expect(reminders[0].retryCount).toBe(1);
      expect(reminders[0].lastAttemptAt).toBeGreaterThan(0);
    });

    it('should be callable multiple times', () => {
      setup();
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now - 120000);
      const id = store.create('group1', 'Alice', 'Test', now - 60000);
      vi.restoreAllMocks();

      store.recordAttempt(id);
      store.recordAttempt(id);
      store.recordAttempt(id);

      const reminders = store.getDueByGroup('group1', now, 50);
      expect(reminders[0].retryCount).toBe(3);
    });
  });

  describe('cancel', () => {
    it('should only work for matching groupId', () => {
      setup();
      const id = store.create('group1', 'Alice', 'Test', Date.now() + 60000);
      const result = store.cancel(id, 'group2');
      expect(result).toBe(false);
    });

    it('should only work for pending reminders', () => {
      setup();
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now - 120000);
      const id = store.create('group1', 'Alice', 'Test', now - 60000);
      vi.restoreAllMocks();

      store.markSent(id);
      const result = store.cancel(id, 'group1');
      expect(result).toBe(false);
    });
  });

  describe('listPending', () => {
    it('should return only pending reminders for that group', () => {
      setup();
      const futureTime = Date.now() + 60000;
      store.create('group1', 'Alice', 'Task 1', futureTime);
      store.create('group1', 'Bob', 'Task 2', futureTime + 1000);
      store.create('group2', 'Charlie', 'Other group', futureTime);

      const reminders = store.listPending('group1');
      expect(reminders).toHaveLength(2);
      expect(reminders[0].reminderText).toBe('Task 1');
      expect(reminders[1].reminderText).toBe('Task 2');
    });
  });
});
