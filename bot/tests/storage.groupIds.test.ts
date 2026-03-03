import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Storage } from '../src/storage';

describe('Storage - getDistinctGroupIds', () => {
  let testDir: string;
  let storage: Storage;

  const createStorage = () => {
    testDir = mkdtempSync(join(tmpdir(), 'signal-bot-groupids-test-'));
    storage = new Storage(join(testDir, 'test.db'));
    return storage;
  };

  afterEach(() => {
    storage?.close();
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should return empty array when no messages exist', () => {
    createStorage();
    expect(storage.getDistinctGroupIds()).toEqual([]);
  });

  it('should return distinct group IDs from messages', () => {
    createStorage();
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
    createStorage();
    storage.addMessage({ groupId: 'group1', sender: 'bot', content: 'Hello', timestamp: Date.now(), isBot: true });

    expect(storage.getDistinctGroupIds()).toEqual(['group1']);
  });

  it('should throw when database is closed', () => {
    createStorage();
    storage.close();
    expect(() => storage.getDistinctGroupIds()).toThrow('Database is closed');
  });
});
