import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Storage } from '../src/storage';

describe('Storage - Reminders', () => {
  let testDir: string;
  let storage: Storage;

  const createStorage = () => {
    testDir = mkdtempSync(join(tmpdir(), 'signal-bot-reminder-test-'));
    storage = new Storage(join(testDir, 'test.db'));
    return storage;
  };

  afterEach(() => {
    storage?.close();
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('createReminder', () => {
    it('should create a reminder and return its ID', () => {
      createStorage();
      const futureTime = Date.now() + 60000;
      const id = storage.createReminder('group1', '+61400000000', 'Buy milk', futureTime);
      expect(id).toBe(1);
    });

    it('should create multiple reminders with incrementing IDs', () => {
      createStorage();
      const futureTime = Date.now() + 60000;
      const id1 = storage.createReminder('group1', '+61400000000', 'Task 1', futureTime);
      const id2 = storage.createReminder('group1', '+61400000000', 'Task 2', futureTime + 1000);
      expect(id2).toBe(id1 + 1);
    });

    it('should reject empty groupId', () => {
      createStorage();
      expect(() => storage.createReminder('', '+61400000000', 'Test', Date.now() + 60000)).toThrow(
        'Invalid groupId: cannot be empty',
      );
    });

    it('should reject empty reminderText', () => {
      createStorage();
      expect(() => storage.createReminder('group1', '+61400000000', '', Date.now() + 60000)).toThrow(
        'Invalid reminderText: cannot be empty',
      );
    });

    it('should reject past dueAt', () => {
      createStorage();
      expect(() => storage.createReminder('group1', '+61400000000', 'Test', Date.now() - 1000)).toThrow(
        'Invalid dueAt: must be in the future',
      );
    });
  });

  describe('getDueReminders', () => {
    it('should return empty array when no reminders exist', () => {
      createStorage();
      const reminders = storage.getDueReminders(Date.now());
      expect(reminders).toEqual([]);
    });

    it('should return only pending reminders where dueAt <= now', () => {
      createStorage();
      const now = Date.now();
      // Use vi.spyOn to allow creating reminders with "past" timestamps
      vi.spyOn(Date, 'now').mockReturnValue(now - 120000);
      storage.createReminder('group1', 'Alice', 'Due reminder', now - 60000);
      storage.createReminder('group1', 'Alice', 'Future reminder', now + 60000);
      vi.restoreAllMocks();

      const reminders = storage.getDueReminders(now);
      expect(reminders).toHaveLength(1);
      expect(reminders[0].reminderText).toBe('Due reminder');
      expect(reminders[0].status).toBe('pending');
    });

    it('should not return sent reminders', () => {
      createStorage();
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now - 120000);
      const id = storage.createReminder('group1', 'Alice', 'Test', now - 60000);
      vi.restoreAllMocks();

      storage.markReminderSent(id);
      const reminders = storage.getDueReminders(now);
      expect(reminders).toHaveLength(0);
    });

    it('should not return failed reminders', () => {
      createStorage();
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now - 120000);
      const id = storage.createReminder('group1', 'Alice', 'Test', now - 60000);
      vi.restoreAllMocks();

      storage.markReminderFailed(id);
      const reminders = storage.getDueReminders(now);
      expect(reminders).toHaveLength(0);
    });

    it('should respect the limit parameter', () => {
      createStorage();
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now - 120000);
      for (let i = 0; i < 5; i++) {
        storage.createReminder('group1', 'Alice', `Reminder ${i}`, now - 60000 + i);
      }
      vi.restoreAllMocks();

      const reminders = storage.getDueReminders(now, 3);
      expect(reminders).toHaveLength(3);
    });

    it('should return results ordered by dueAt ASC', () => {
      createStorage();
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now - 200000);
      storage.createReminder('group1', 'Alice', 'Later', now - 30000);
      storage.createReminder('group1', 'Alice', 'Earlier', now - 60000);
      vi.restoreAllMocks();

      const reminders = storage.getDueReminders(now);
      expect(reminders[0].reminderText).toBe('Earlier');
      expect(reminders[1].reminderText).toBe('Later');
    });
  });

  describe('markReminderSent', () => {
    it('should mark a pending reminder as sent', () => {
      createStorage();
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now - 120000);
      const id = storage.createReminder('group1', 'Alice', 'Test', now - 60000);
      vi.restoreAllMocks();

      const result = storage.markReminderSent(id);
      expect(result).toBe(true);

      // Verify it's no longer in due reminders
      const reminders = storage.getDueReminders(now);
      expect(reminders).toHaveLength(0);
    });

    it('should return false for already-sent reminders', () => {
      createStorage();
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now - 120000);
      const id = storage.createReminder('group1', 'Alice', 'Test', now - 60000);
      vi.restoreAllMocks();

      storage.markReminderSent(id);
      const result = storage.markReminderSent(id);
      expect(result).toBe(false);
    });

    it('should return false for non-existent ID', () => {
      createStorage();
      const result = storage.markReminderSent(999);
      expect(result).toBe(false);
    });
  });

  describe('markReminderFailed', () => {
    it('should mark a pending reminder as failed', () => {
      createStorage();
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now - 120000);
      const id = storage.createReminder('group1', 'Alice', 'Test', now - 60000);
      vi.restoreAllMocks();

      const result = storage.markReminderFailed(id);
      expect(result).toBe(true);
    });

    it('should return false for non-pending reminders', () => {
      createStorage();
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now - 120000);
      const id = storage.createReminder('group1', 'Alice', 'Test', now - 60000);
      vi.restoreAllMocks();

      storage.markReminderSent(id);
      const result = storage.markReminderFailed(id);
      expect(result).toBe(false);
    });
  });

  describe('incrementReminderRetry', () => {
    it('should increment the retry count', () => {
      createStorage();
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now - 120000);
      const id = storage.createReminder('group1', 'Alice', 'Test', now - 60000);
      vi.restoreAllMocks();

      storage.incrementReminderRetry(id);
      storage.incrementReminderRetry(id);

      const reminders = storage.getDueReminders(now);
      expect(reminders[0].retryCount).toBe(2);
    });
  });

  describe('cancelReminder', () => {
    it('should cancel a pending reminder', () => {
      createStorage();
      const id = storage.createReminder('group1', 'Alice', 'Test', Date.now() + 60000);
      const result = storage.cancelReminder(id, 'group1');
      expect(result).toBe(true);
    });

    it('should not cancel a reminder from a different group', () => {
      createStorage();
      const id = storage.createReminder('group1', 'Alice', 'Test', Date.now() + 60000);
      const result = storage.cancelReminder(id, 'group2');
      expect(result).toBe(false);
    });

    it('should not cancel an already-sent reminder', () => {
      createStorage();
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now - 120000);
      const id = storage.createReminder('group1', 'Alice', 'Test', now - 60000);
      vi.restoreAllMocks();

      storage.markReminderSent(id);
      const result = storage.cancelReminder(id, 'group1');
      expect(result).toBe(false);
    });

    it('should return false for non-existent ID', () => {
      createStorage();
      const result = storage.cancelReminder(999, 'group1');
      expect(result).toBe(false);
    });
  });

  describe('listReminders', () => {
    it('should list pending reminders for a group', () => {
      createStorage();
      const futureTime = Date.now() + 60000;
      storage.createReminder('group1', 'Alice', 'Task 1', futureTime);
      storage.createReminder('group1', 'Bob', 'Task 2', futureTime + 1000);

      const reminders = storage.listReminders('group1');
      expect(reminders).toHaveLength(2);
      expect(reminders[0].reminderText).toBe('Task 1');
      expect(reminders[1].reminderText).toBe('Task 2');
    });

    it('should not list reminders from other groups', () => {
      createStorage();
      const futureTime = Date.now() + 60000;
      storage.createReminder('group1', 'Alice', 'Task 1', futureTime);
      storage.createReminder('group2', 'Bob', 'Task 2', futureTime);

      const reminders = storage.listReminders('group1');
      expect(reminders).toHaveLength(1);
      expect(reminders[0].reminderText).toBe('Task 1');
    });

    it('should not list sent or cancelled reminders', () => {
      createStorage();
      const futureTime = Date.now() + 60000;
      const id1 = storage.createReminder('group1', 'Alice', 'Sent', futureTime);
      storage.createReminder('group1', 'Alice', 'Pending', futureTime + 1000);
      const id3 = storage.createReminder('group1', 'Alice', 'Cancelled', futureTime + 2000);

      vi.spyOn(Date, 'now').mockReturnValue(futureTime + 5000);
      storage.markReminderSent(id1);
      vi.restoreAllMocks();
      storage.cancelReminder(id3, 'group1');

      const reminders = storage.listReminders('group1');
      expect(reminders).toHaveLength(1);
      expect(reminders[0].reminderText).toBe('Pending');
    });

    it('should reject empty groupId', () => {
      createStorage();
      expect(() => storage.listReminders('')).toThrow('Invalid groupId: cannot be empty');
    });
  });

  describe('close guard for reminder methods', () => {
    it('should throw on createReminder after close', () => {
      createStorage();
      storage.close();
      expect(() => storage.createReminder('g1', 'Alice', 'Test', Date.now() + 60000)).toThrow('Database is closed');
    });

    it('should throw on getDueReminders after close', () => {
      createStorage();
      storage.close();
      expect(() => storage.getDueReminders()).toThrow('Database is closed');
    });

    it('should throw on listReminders after close', () => {
      createStorage();
      storage.close();
      expect(() => storage.listReminders('g1')).toThrow('Database is closed');
    });

    it('should throw on cancelReminder after close', () => {
      createStorage();
      storage.close();
      expect(() => storage.cancelReminder(1, 'g1')).toThrow('Database is closed');
    });
  });
});
