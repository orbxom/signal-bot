import { afterEach, describe, expect, it } from 'vitest';
import { MEMORY_TOKEN_LIMIT, MemoryStore } from '../../src/stores/memoryStore';
import { createTestDb, type TestDb } from '../helpers/testDb';

describe('MemoryStore', () => {
  let db: TestDb;
  let store: MemoryStore;

  const setup = () => {
    db = createTestDb('signal-bot-memory-store-test-');
    store = new MemoryStore(db.conn);
    return store;
  };

  afterEach(() => {
    db?.cleanup();
  });

  describe('upsert', () => {
    it('should create a new memory', () => {
      setup();
      const memory = store.upsert('group1', 'groceries', 'Buy milk and eggs');
      expect(memory).toMatchObject({
        groupId: 'group1',
        topic: 'groceries',
        content: 'Buy milk and eggs',
      });
      expect(memory.id).toBeGreaterThan(0);
      expect(memory.createdAt).toBeGreaterThan(0);
      expect(memory.updatedAt).toBeGreaterThan(0);
    });

    it('should update an existing memory with same groupId and topic', () => {
      setup();
      const first = store.upsert('group1', 'groceries', 'Buy milk');
      const second = store.upsert('group1', 'groceries', 'Buy milk and eggs');
      expect(second.id).toBe(first.id);
      expect(second.content).toBe('Buy milk and eggs');
    });

    it('should reject empty groupId', () => {
      setup();
      expect(() => store.upsert('', 'groceries', 'Buy milk')).toThrow('Invalid groupId: cannot be empty');
    });

    it('should reject empty topic', () => {
      setup();
      expect(() => store.upsert('group1', '', 'Buy milk')).toThrow('Invalid topic: cannot be empty');
    });

    it('should reject content exceeding token limit', () => {
      setup();
      const longContent = 'a'.repeat(MEMORY_TOKEN_LIMIT * 4 + 1);
      expect(() => store.upsert('group1', 'groceries', longContent)).toThrow('exceeds token limit');
    });

    it('should allow content at exactly the token limit', () => {
      setup();
      const exactContent = 'a'.repeat(MEMORY_TOKEN_LIMIT * 4);
      const memory = store.upsert('group1', 'groceries', exactContent);
      expect(memory.content).toBe(exactContent);
    });

    it('should preserve createdAt on update but change updatedAt', async () => {
      setup();
      const first = store.upsert('group1', 'groceries', 'V1');
      await new Promise(resolve => setTimeout(resolve, 20));
      const second = store.upsert('group1', 'groceries', 'V2');
      expect(second.createdAt).toBe(first.createdAt);
      expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
    });
  });

  describe('get', () => {
    it('should return memory for existing topic', () => {
      setup();
      store.upsert('group1', 'groceries', 'Buy milk');
      const memory = store.get('group1', 'groceries');
      expect(memory).not.toBeNull();
      expect(memory?.topic).toBe('groceries');
      expect(memory?.content).toBe('Buy milk');
    });

    it('should return null for non-existent topic', () => {
      setup();
      const memory = store.get('group1', 'nonexistent');
      expect(memory).toBeNull();
    });
  });

  describe('getByGroup', () => {
    it('should return all memories for a group', () => {
      setup();
      store.upsert('group1', 'groceries', 'Buy milk');
      store.upsert('group1', 'todos', 'Fix the fence');
      const memories = store.getByGroup('group1');
      expect(memories).toHaveLength(2);
    });

    it('should not return memories from other groups', () => {
      setup();
      store.upsert('group1', 'groceries', 'Buy milk');
      store.upsert('group2', 'todos', 'Fix the fence');
      const memories = store.getByGroup('group1');
      expect(memories).toHaveLength(1);
      expect(memories[0].topic).toBe('groceries');
    });

    it('should return empty array when none exist', () => {
      setup();
      const memories = store.getByGroup('group1');
      expect(memories).toEqual([]);
    });

    it('should return ordered by topic ASC', () => {
      setup();
      store.upsert('group1', 'todos', 'Fix the fence');
      store.upsert('group1', 'allergies', 'No peanuts');
      store.upsert('group1', 'groceries', 'Buy milk');
      const memories = store.getByGroup('group1');
      expect(memories[0].topic).toBe('allergies');
      expect(memories[1].topic).toBe('groceries');
      expect(memories[2].topic).toBe('todos');
    });

    it('should reject empty groupId', () => {
      setup();
      expect(() => store.getByGroup('')).toThrow('Invalid groupId: cannot be empty');
    });
  });

  describe('listAll', () => {
    it('lists memories across all groups', () => {
      setup();
      store.upsert('group1', 'groceries', 'Buy milk');
      store.upsert('group2', 'todos', 'Fix fence');
      const all = store.listAll();
      expect(all).toHaveLength(2);
    });

    it('filters by groupId', () => {
      setup();
      store.upsert('group1', 'groceries', 'Buy milk');
      store.upsert('group2', 'todos', 'Fix fence');
      const filtered = store.listAll({ groupId: 'group1' });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].topic).toBe('groceries');
    });

    it('supports pagination', () => {
      setup();
      for (let i = 0; i < 5; i++) {
        store.upsert('group1', `topic${i}`, `content ${i}`);
      }
      const page = store.listAll({ limit: 2, offset: 2 });
      expect(page).toHaveLength(2);
    });
  });

  describe('delete', () => {
    it('should delete an existing memory', () => {
      setup();
      store.upsert('group1', 'groceries', 'Buy milk');
      const result = store.delete('group1', 'groceries');
      expect(result).toBe(true);
      const memory = store.get('group1', 'groceries');
      expect(memory).toBeNull();
    });

    it('should return false for non-existent memory', () => {
      setup();
      const result = store.delete('group1', 'nonexistent');
      expect(result).toBe(false);
    });
  });
});
