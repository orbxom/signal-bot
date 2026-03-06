import { afterEach, describe, expect, it } from 'vitest';
import { createTestStorage, type TestStorage } from './helpers/testDb';

describe('Storage - getDistinctGroupIds', () => {
  let ts: TestStorage;

  const createStorage = () => {
    ts = createTestStorage('signal-bot-groupids-test-');
    return ts.storage;
  };

  afterEach(() => {
    ts?.cleanup();
  });

  it('should return empty array when no messages exist', () => {
    const storage = createStorage();
    expect(storage.getDistinctGroupIds()).toEqual([]);
  });

  it('should return distinct group IDs from messages', () => {
    const storage = createStorage();
    const now = Date.now();
    storage.addMessage({ groupId: 'group1', sender: 'Alice', content: 'Hi', timestamp: now, isBot: false });
    storage.addMessage({ groupId: 'group2', sender: 'Bob', content: 'Hey', timestamp: now + 1, isBot: false });
    storage.addMessage({ groupId: 'group1', sender: 'Alice', content: 'Again', timestamp: now + 2, isBot: false });

    const groupIds = storage.getDistinctGroupIds();
    expect(groupIds).toHaveLength(2);
    expect(groupIds).toContain('group1');
    expect(groupIds).toContain('group2');
  });

  it('should include groups with only bot messages', () => {
    const storage = createStorage();
    storage.addMessage({ groupId: 'group1', sender: 'bot', content: 'Hello', timestamp: Date.now(), isBot: true });

    expect(storage.getDistinctGroupIds()).toEqual(['group1']);
  });

  it('should throw when database is closed', () => {
    const storage = createStorage();
    storage.close();
    expect(() => storage.getDistinctGroupIds()).toThrow('Database is closed');
  });
});
