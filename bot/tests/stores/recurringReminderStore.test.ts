import { afterEach, describe, expect, it } from 'vitest';
import { IN_FLIGHT_TIMEOUT_MS, RecurringReminderStore } from '../../src/stores/recurringReminderStore';
import { createTestDb, type TestDb } from '../helpers/testDb';

describe('RecurringReminderStore', () => {
  let db: TestDb;
  let store: RecurringReminderStore;

  const setup = () => {
    db = createTestDb('signal-bot-recurring-reminder-store-test-');
    store = new RecurringReminderStore(db.conn);
    return store;
  };

  afterEach(() => {
    db?.cleanup();
  });

  const NOW = 1700000000000;
  const NEXT_DUE = NOW + 3600000; // 1 hour from now

  describe('create', () => {
    it('should return auto-incrementing ID', () => {
      setup();
      const id1 = store.create('group1', '+61400000000', 'Do task 1', '0 9 * * *', 'Australia/Sydney', NOW + 1000);
      const id2 = store.create('group1', '+61400000000', 'Do task 2', '0 10 * * *', 'Australia/Sydney', NOW + 2000);
      expect(id1).toBe(1);
      expect(id2).toBe(2);
    });

    it('should reject empty groupId', () => {
      setup();
      expect(() => store.create('', '+61400000000', 'Test', '0 9 * * *', 'Australia/Sydney', NOW)).toThrow(
        'Invalid groupId: cannot be empty',
      );
    });

    it('should reject empty promptText', () => {
      setup();
      expect(() => store.create('group1', '+61400000000', '', '0 9 * * *', 'Australia/Sydney', NOW)).toThrow(
        'Invalid promptText: cannot be empty',
      );
    });
  });

  describe('getGroupsWithDue', () => {
    it('should return groups with due reminders', () => {
      setup();
      store.create('group1', 'Alice', 'Task A', '0 9 * * *', 'UTC', NOW - 1000);
      store.create('group2', 'Bob', 'Task B', '0 10 * * *', 'UTC', NOW - 500);

      const groups = store.getGroupsWithDue(NOW);
      expect(groups).toHaveLength(2);
      expect(groups).toContain('group1');
      expect(groups).toContain('group2');
    });

    it('should exclude groups with only future reminders', () => {
      setup();
      store.create('group1', 'Alice', 'Future task', '0 9 * * *', 'UTC', NOW + 60000);

      const groups = store.getGroupsWithDue(NOW);
      expect(groups).toHaveLength(0);
    });

    it('should exclude reminders with recent lastInFlightAt', () => {
      setup();
      const id = store.create('group1', 'Alice', 'Task', '0 9 * * *', 'UTC', NOW - 1000);
      store.markInFlight(id);

      // The in-flight marker is recent, so this group should be excluded
      const groups = store.getGroupsWithDue(NOW);
      expect(groups).toHaveLength(0);
    });

    it('should include reminders with expired lastInFlightAt', () => {
      setup();
      const now = Date.now();
      const id = store.create('group1', 'Alice', 'Task', '0 9 * * *', 'UTC', now - 1000);
      store.markInFlight(id);

      // Check after the timeout has expired (lastInFlightAt was set to ~now by markInFlight)
      const afterTimeout = now + IN_FLIGHT_TIMEOUT_MS + 1000;
      const groups = store.getGroupsWithDue(afterTimeout);
      expect(groups).toHaveLength(1);
      expect(groups).toContain('group1');
    });
  });

  describe('getDueByGroup', () => {
    it('should return due reminders for the group', () => {
      setup();
      store.create('group1', 'Alice', 'Task A', '0 9 * * *', 'UTC', NOW - 1000);
      store.create('group1', 'Alice', 'Task B', '0 10 * * *', 'UTC', NOW - 500);
      store.create('group2', 'Bob', 'Other group', '0 9 * * *', 'UTC', NOW - 1000);

      const reminders = store.getDueByGroup('group1', NOW, 50);
      expect(reminders).toHaveLength(2);
      expect(reminders[0].promptText).toBe('Task A');
      expect(reminders[1].promptText).toBe('Task B');
    });

    it('should skip reminders with recent lastInFlightAt', () => {
      setup();
      const id = store.create('group1', 'Alice', 'Task', '0 9 * * *', 'UTC', NOW - 1000);
      store.markInFlight(id);

      const reminders = store.getDueByGroup('group1', NOW, 50);
      expect(reminders).toHaveLength(0);
    });

    it('should include reminders with expired lastInFlightAt (>7min)', () => {
      setup();
      const now = Date.now();
      const id = store.create('group1', 'Alice', 'Task', '0 9 * * *', 'UTC', now - 1000);
      store.markInFlight(id);

      const afterTimeout = now + IN_FLIGHT_TIMEOUT_MS + 1000;
      const reminders = store.getDueByGroup('group1', afterTimeout, 50);
      expect(reminders).toHaveLength(1);
      expect(reminders[0].promptText).toBe('Task');
    });

    it('should respect limit', () => {
      setup();
      for (let i = 0; i < 5; i++) {
        store.create('group1', 'Alice', `Task ${i}`, '0 9 * * *', 'UTC', NOW - 1000 + i);
      }

      const reminders = store.getDueByGroup('group1', NOW, 3);
      expect(reminders).toHaveLength(3);
    });
  });

  describe('markInFlight', () => {
    it('should claim successfully', () => {
      setup();
      const id = store.create('group1', 'Alice', 'Task', '0 9 * * *', 'UTC', NOW - 1000);

      const result = store.markInFlight(id);
      expect(result).toBe(true);
    });

    it('should reject double claim', () => {
      setup();
      const id = store.create('group1', 'Alice', 'Task', '0 9 * * *', 'UTC', NOW - 1000);

      store.markInFlight(id);
      const result = store.markInFlight(id);
      expect(result).toBe(false);
    });
  });

  describe('markFired', () => {
    it('should advance nextDueAt and clear lastInFlightAt', () => {
      setup();
      const id = store.create('group1', 'Alice', 'Task', '0 9 * * *', 'UTC', NOW - 1000);
      store.markInFlight(id);

      const result = store.markFired(id, NEXT_DUE);
      expect(result).toBe(true);

      const active = store.listActive('group1');
      expect(active).toHaveLength(1);
      expect(active[0].nextDueAt).toBe(NEXT_DUE);
      expect(active[0].lastInFlightAt).toBeNull();
      expect(active[0].lastFiredAt).toBeGreaterThan(0);
    });

    it('should reset consecutiveFailures', () => {
      setup();
      const id = store.create('group1', 'Alice', 'Task', '0 9 * * *', 'UTC', NOW - 1000);
      store.incrementFailures(id);
      store.incrementFailures(id);
      store.markInFlight(id);

      store.markFired(id, NEXT_DUE);

      const active = store.listActive('group1');
      expect(active[0].consecutiveFailures).toBe(0);
    });
  });

  describe('clearInFlight', () => {
    it('should release claim and allow re-claim', () => {
      setup();
      const id = store.create('group1', 'Alice', 'Task', '0 9 * * *', 'UTC', NOW - 1000);
      store.markInFlight(id);

      store.clearInFlight(id);

      // Should be claimable again
      const result = store.markInFlight(id);
      expect(result).toBe(true);
    });
  });

  describe('cancel', () => {
    it('should cancel active reminder', () => {
      setup();
      const id = store.create('group1', 'Alice', 'Task', '0 9 * * *', 'UTC', NOW + 1000);

      const result = store.cancel(id, 'group1');
      expect(result).toBe(true);

      const active = store.listActive('group1');
      expect(active).toHaveLength(0);
    });

    it('should reject wrong group', () => {
      setup();
      const id = store.create('group1', 'Alice', 'Task', '0 9 * * *', 'UTC', NOW + 1000);

      const result = store.cancel(id, 'group2');
      expect(result).toBe(false);
    });

    it('should not cancel already-cancelled reminder', () => {
      setup();
      const id = store.create('group1', 'Alice', 'Task', '0 9 * * *', 'UTC', NOW + 1000);
      store.cancel(id, 'group1');

      const result = store.cancel(id, 'group1');
      expect(result).toBe(false);
    });
  });

  describe('listActive', () => {
    it('should list active reminders ordered by nextDueAt', () => {
      setup();
      store.create('group1', 'Alice', 'Later task', '0 10 * * *', 'UTC', NOW + 2000);
      store.create('group1', 'Alice', 'Earlier task', '0 9 * * *', 'UTC', NOW + 1000);

      const active = store.listActive('group1');
      expect(active).toHaveLength(2);
      expect(active[0].promptText).toBe('Earlier task');
      expect(active[1].promptText).toBe('Later task');
    });

    it('should exclude cancelled reminders', () => {
      setup();
      const id = store.create('group1', 'Alice', 'Cancelled task', '0 9 * * *', 'UTC', NOW + 1000);
      store.create('group1', 'Alice', 'Active task', '0 10 * * *', 'UTC', NOW + 2000);
      store.cancel(id, 'group1');

      const active = store.listActive('group1');
      expect(active).toHaveLength(1);
      expect(active[0].promptText).toBe('Active task');
    });
  });

  describe('advanceNextDue', () => {
    it('should update nextDueAt and clear lastInFlightAt without resetting failures', () => {
      setup();
      const id = store.create('group1', 'Alice', 'Task', '0 9 * * *', 'UTC', NOW - 1000);
      store.markInFlight(id);
      store.incrementFailures(id);
      store.incrementFailures(id);

      store.advanceNextDue(id, NEXT_DUE);

      const active = store.listActive('group1');
      expect(active).toHaveLength(1);
      expect(active[0].nextDueAt).toBe(NEXT_DUE);
      expect(active[0].lastInFlightAt).toBeNull();
      expect(active[0].consecutiveFailures).toBe(2); // NOT reset
    });
  });

  describe('listAll', () => {
    it('lists active recurring reminders across all groups', () => {
      setup();
      store.create('group1', 'user1', 'task1', '0 9 * * *', 'UTC', NOW + 1000);
      store.create('group2', 'user2', 'task2', '0 10 * * *', 'UTC', NOW + 2000);
      const all = store.listAll();
      expect(all).toHaveLength(2);
    });

    it('filters by groupId', () => {
      setup();
      store.create('group1', 'user1', 'task1', '0 9 * * *', 'UTC', NOW + 1000);
      store.create('group2', 'user2', 'task2', '0 10 * * *', 'UTC', NOW + 2000);
      const filtered = store.listAll({ groupId: 'group1' });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].groupId).toBe('group1');
    });

    it('excludes cancelled reminders', () => {
      setup();
      const id = store.create('group1', 'user1', 'task1', '0 9 * * *', 'UTC', NOW + 1000);
      store.create('group1', 'user2', 'task2', '0 10 * * *', 'UTC', NOW + 2000);
      store.cancel(id, 'group1');
      const all = store.listAll();
      expect(all).toHaveLength(1);
    });

    it('supports pagination', () => {
      setup();
      for (let i = 0; i < 5; i++) {
        store.create('group1', 'user1', `task${i}`, '0 9 * * *', 'UTC', NOW + i * 1000);
      }
      const page = store.listAll({ limit: 2, offset: 2 });
      expect(page).toHaveLength(2);
    });
  });

  describe('resetFailures', () => {
    it('resets consecutiveFailures to zero', () => {
      setup();
      const id = store.create('group1', 'user1', 'task', '0 9 * * *', 'UTC', NOW + 1000);
      store.incrementFailures(id);
      store.incrementFailures(id);
      const result = store.resetFailures(id);
      expect(result).toBe(true);
      const all = store.listAll();
      expect(all[0].consecutiveFailures).toBe(0);
    });

    it('returns false for non-existent id', () => {
      setup();
      expect(store.resetFailures(999)).toBe(false);
    });
  });

  describe('handleFailure', () => {
    it('should atomically advance nextDueAt, clear lastInFlightAt, and increment failures', () => {
      setup();
      const id = store.create('group1', 'Alice', 'Task', '0 9 * * *', 'UTC', NOW - 1000);
      store.markInFlight(id);

      const failures = store.handleFailure(id, NEXT_DUE);
      expect(failures).toBe(1);

      const active = store.listActive('group1');
      expect(active).toHaveLength(1);
      expect(active[0].nextDueAt).toBe(NEXT_DUE);
      expect(active[0].lastInFlightAt).toBeNull();
      expect(active[0].consecutiveFailures).toBe(1);
    });

    it('should return incrementing failure count on repeated calls', () => {
      setup();
      const id = store.create('group1', 'Alice', 'Task', '0 9 * * *', 'UTC', NOW - 1000);

      const count1 = store.handleFailure(id, NEXT_DUE);
      expect(count1).toBe(1);

      const count2 = store.handleFailure(id, NEXT_DUE + 3600000);
      expect(count2).toBe(2);
    });
  });


  describe('incrementFailures', () => {
    it('should increment count and return new value', () => {
      setup();
      const id = store.create('group1', 'Alice', 'Task', '0 9 * * *', 'UTC', NOW + 1000);

      const count1 = store.incrementFailures(id);
      expect(count1).toBe(1);

      const count2 = store.incrementFailures(id);
      expect(count2).toBe(2);

      const count3 = store.incrementFailures(id);
      expect(count3).toBe(3);
    });
  });
});
