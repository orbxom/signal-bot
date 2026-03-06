import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Storage } from '../src/storage';
import { MEMORY_TOKEN_LIMIT } from '../src/stores/memoryStore';

describe('Storage - Memories', () => {
  let testDir: string;
  let storage: Storage;

  const createStorage = () => {
    testDir = mkdtempSync(join(tmpdir(), 'signal-bot-memory-test-'));
    storage = new Storage(join(testDir, 'test.db'));
    return storage;
  };

  afterEach(() => {
    storage?.close();
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('upsertMemory', () => {
    it('should create a new memory', () => {
      createStorage();
      const memory = storage.upsertMemory('group1', 'holiday plans', 'Going to Bali in March');
      expect(memory).toMatchObject({
        groupId: 'group1',
        topic: 'holiday plans',
        content: 'Going to Bali in March',
      });
      expect(memory.id).toBeGreaterThan(0);
      expect(memory.createdAt).toBeGreaterThan(0);
      expect(memory.updatedAt).toBeGreaterThan(0);
    });

    it('should update an existing memory with same groupId and topic', () => {
      createStorage();
      const first = storage.upsertMemory('group1', 'holiday plans', 'Going to Bali');
      const second = storage.upsertMemory('group1', 'holiday plans', 'Going to Bali in April instead');
      expect(second.id).toBe(first.id);
      expect(second.content).toBe('Going to Bali in April instead');
    });

    it('should reject content exceeding token limit', () => {
      createStorage();
      const longContent = 'a'.repeat(MEMORY_TOKEN_LIMIT * 4 + 1);
      expect(() => storage.upsertMemory('group1', 'too long', longContent)).toThrow('exceeds token limit');
    });
  });

  describe('getMemory', () => {
    it('should return existing memory', () => {
      createStorage();
      storage.upsertMemory('group1', 'dietary', 'No peanuts');
      const memory = storage.getMemory('group1', 'dietary');
      expect(memory).not.toBeNull();
      expect(memory?.topic).toBe('dietary');
      expect(memory?.content).toBe('No peanuts');
    });

    it('should return null for non-existent topic', () => {
      createStorage();
      const memory = storage.getMemory('group1', 'nonexistent');
      expect(memory).toBeNull();
    });
  });

  describe('getMemoriesByGroup', () => {
    it('should return all memories for a group', () => {
      createStorage();
      storage.upsertMemory('group1', 'topic1', 'Content 1');
      storage.upsertMemory('group1', 'topic2', 'Content 2');
      const memories = storage.getMemoriesByGroup('group1');
      expect(memories).toHaveLength(2);
    });

    it('should not return memories from other groups', () => {
      createStorage();
      storage.upsertMemory('group1', 'topic1', 'Content 1');
      storage.upsertMemory('group2', 'topic2', 'Content 2');
      const memories = storage.getMemoriesByGroup('group1');
      expect(memories).toHaveLength(1);
      expect(memories[0].topic).toBe('topic1');
    });
  });

  describe('deleteMemory', () => {
    it('should delete an existing memory', () => {
      createStorage();
      storage.upsertMemory('group1', 'topic1', 'Content');
      const result = storage.deleteMemory('group1', 'topic1');
      expect(result).toBe(true);
      const memory = storage.getMemory('group1', 'topic1');
      expect(memory).toBeNull();
    });

    it('should return false for non-existent memory', () => {
      createStorage();
      const result = storage.deleteMemory('group1', 'nobody');
      expect(result).toBe(false);
    });
  });

  describe('close guard for memory methods', () => {
    it('should throw on upsertMemory after close', () => {
      createStorage();
      storage.close();
      expect(() => storage.upsertMemory('g1', 'topic', 'content')).toThrow('Database is closed');
    });

    it('should throw on getMemory after close', () => {
      createStorage();
      storage.close();
      expect(() => storage.getMemory('g1', 'topic')).toThrow('Database is closed');
    });

    it('should throw on getMemoriesByGroup after close', () => {
      createStorage();
      storage.close();
      expect(() => storage.getMemoriesByGroup('g1')).toThrow('Database is closed');
    });

    it('should throw on deleteMemory after close', () => {
      createStorage();
      storage.close();
      expect(() => storage.deleteMemory('g1', 'topic')).toThrow('Database is closed');
    });
  });
});
