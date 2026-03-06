import { afterEach, describe, expect, it } from 'vitest';
import type { Storage } from '../src/storage';
import { createTestStorage, type TestStorage } from './helpers/testDb';

describe('Storage - Memories (facade delegation)', () => {
  let ts: TestStorage;

  const createStorage = (): Storage => {
    ts = createTestStorage('signal-bot-memory-test-');
    return ts.storage;
  };

  afterEach(() => {
    ts?.cleanup();
  });

  it('should delegate upsertMemory to memories.upsert', () => {
    const storage = createStorage();
    const memory = storage.upsertMemory('group1', 'groceries', 'Buy milk');
    expect(memory.topic).toBe('groceries');
    expect(storage.memories.get('group1', 'groceries')?.content).toBe('Buy milk');
  });

  it('should delegate getMemory to memories.get', () => {
    const storage = createStorage();
    storage.memories.upsert('group1', 'groceries', 'Buy milk');
    const memory = storage.getMemory('group1', 'groceries');
    expect(memory?.topic).toBe('groceries');
  });

  it('should delegate getMemoriesByGroup to memories.getByGroup', () => {
    const storage = createStorage();
    storage.memories.upsert('group1', 'topic1', 'Content 1');
    storage.memories.upsert('group1', 'topic2', 'Content 2');
    const memories = storage.getMemoriesByGroup('group1');
    expect(memories).toHaveLength(2);
  });

  it('should delegate deleteMemory to memories.delete', () => {
    const storage = createStorage();
    storage.memories.upsert('group1', 'groceries', 'Buy milk');
    const result = storage.deleteMemory('group1', 'groceries');
    expect(result).toBe(true);
    expect(storage.memories.get('group1', 'groceries')).toBeNull();
  });

  describe('close guard for memory methods', () => {
    it('should throw on upsertMemory after close', () => {
      const storage = createStorage();
      storage.close();
      expect(() => storage.upsertMemory('g1', 'topic', 'content')).toThrow('Database is closed');
    });

    it('should throw on getMemory after close', () => {
      const storage = createStorage();
      storage.close();
      expect(() => storage.getMemory('g1', 'topic')).toThrow('Database is closed');
    });

    it('should throw on getMemoriesByGroup after close', () => {
      const storage = createStorage();
      storage.close();
      expect(() => storage.getMemoriesByGroup('g1')).toThrow('Database is closed');
    });

    it('should throw on deleteMemory after close', () => {
      const storage = createStorage();
      storage.close();
      expect(() => storage.deleteMemory('g1', 'topic')).toThrow('Database is closed');
    });
  });
});
