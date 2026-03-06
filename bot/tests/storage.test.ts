import { afterEach, describe, expect, it } from 'vitest';
import type { Storage } from '../src/storage';
import { createTestStorage, type TestStorage } from './helpers/testDb';

describe('Storage', () => {
  let ts: TestStorage;

  const createStorage = (): Storage => {
    ts = createTestStorage();
    return ts.storage;
  };

  afterEach(() => {
    ts?.cleanup();
  });

  it('should initialize database with tables', () => {
    const storage = createStorage();
    expect(storage).toBeDefined();
  });

  it('should add and retrieve messages', () => {
    const storage = createStorage();

    storage.addMessage({
      groupId: 'group1',
      sender: 'Alice',
      content: 'Hello',
      timestamp: Date.now(),
      isBot: false,
    });

    const messages = storage.getRecentMessages('group1', 10);
    expect(messages).toHaveLength(1);
    expect(messages[0].sender).toBe('Alice');
    expect(messages[0].content).toBe('Hello');
  });

  it('should trim old messages beyond window size', () => {
    const storage = createStorage();
    const groupId = 'group1';

    for (let i = 0; i < 25; i++) {
      storage.addMessage({
        groupId,
        sender: 'User',
        content: `Message ${i}`,
        timestamp: Date.now() + i,
        isBot: false,
      });
    }

    storage.trimMessages(groupId, 20);
    const messages = storage.getRecentMessages(groupId, 100);
    expect(messages).toHaveLength(20);
    expect(messages[0].content).toBe('Message 5');
  });

  describe('attachment storage', () => {
    it('should store and retrieve attachments', () => {
      const storage = createStorage();
      const attachments = [{ id: 'voice-abc', contentType: 'audio/aac', size: 5000, filename: null }];

      storage.addMessage({
        groupId: 'group1',
        sender: 'Alice',
        content: '',
        timestamp: Date.now(),
        isBot: false,
        attachments,
      });

      const messages = storage.getRecentMessages('group1', 10);
      expect(messages).toHaveLength(1);
      expect(messages[0].attachments).toEqual(attachments);
    });

    it('should return undefined attachments when none stored', () => {
      const storage = createStorage();

      storage.addMessage({
        groupId: 'group1',
        sender: 'Alice',
        content: 'Hello',
        timestamp: Date.now(),
        isBot: false,
      });

      const messages = storage.getRecentMessages('group1', 10);
      expect(messages[0].attachments).toBeUndefined();
    });

    it('should not store attachments when array is empty', () => {
      const storage = createStorage();

      storage.addMessage({
        groupId: 'group1',
        sender: 'Alice',
        content: 'Hello',
        timestamp: Date.now(),
        isBot: false,
        attachments: [],
      });

      const messages = storage.getRecentMessages('group1', 10);
      expect(messages[0].attachments).toBeUndefined();
    });
  });

  describe('close guard', () => {
    it('should throw when calling addMessage after close', () => {
      const storage = createStorage();
      storage.close();

      expect(() =>
        storage.addMessage({
          groupId: 'g1',
          sender: 'Alice',
          content: 'Hello',
          timestamp: Date.now(),
          isBot: false,
        }),
      ).toThrow('Database is closed');
    });

    it('should throw when calling getRecentMessages after close', () => {
      const storage = createStorage();
      storage.close();

      expect(() => storage.getRecentMessages('g1', 10)).toThrow('Database is closed');
    });

    it('should throw when calling trimMessages after close', () => {
      const storage = createStorage();
      storage.close();

      expect(() => storage.trimMessages('g1', 20)).toThrow('Database is closed');
    });

    it('should not throw when calling close twice', () => {
      const storage = createStorage();
      storage.close();
      expect(() => storage.close()).not.toThrow();
    });
  });
});
