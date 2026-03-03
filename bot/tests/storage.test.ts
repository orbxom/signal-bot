import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Storage } from '../src/storage';

describe('Storage', () => {
  let testDir: string;
  let testDbPath: string;

  const createTestDb = () => {
    testDir = mkdtempSync(join(tmpdir(), 'signal-bot-test-'));
    testDbPath = join(testDir, 'test.db');
    return testDbPath;
  };

  afterEach(() => {
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should initialize database with tables', () => {
    const storage = new Storage(createTestDb());
    try {
      expect(storage).toBeDefined();
    } finally {
      storage.close();
    }
  });

  it('should add and retrieve messages', () => {
    const storage = new Storage(createTestDb());

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

    storage.close();
  });

  it('should trim old messages beyond window size', () => {
    const storage = new Storage(createTestDb());
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

    storage.close();
  });

  describe('attachment storage', () => {
    it('should store and retrieve attachments', () => {
      const storage = new Storage(createTestDb());
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

      storage.close();
    });

    it('should return undefined attachments when none stored', () => {
      const storage = new Storage(createTestDb());

      storage.addMessage({
        groupId: 'group1',
        sender: 'Alice',
        content: 'Hello',
        timestamp: Date.now(),
        isBot: false,
      });

      const messages = storage.getRecentMessages('group1', 10);
      expect(messages[0].attachments).toBeUndefined();

      storage.close();
    });

    it('should not store attachments when array is empty', () => {
      const storage = new Storage(createTestDb());

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

      storage.close();
    });
  });

  describe('close guard', () => {
    it('should throw when calling addMessage after close', () => {
      const storage = new Storage(createTestDb());
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
      const storage = new Storage(createTestDb());
      storage.close();

      expect(() => storage.getRecentMessages('g1', 10)).toThrow('Database is closed');
    });

    it('should throw when calling trimMessages after close', () => {
      const storage = new Storage(createTestDb());
      storage.close();

      expect(() => storage.trimMessages('g1', 20)).toThrow('Database is closed');
    });

    it('should not throw when calling close twice', () => {
      const storage = new Storage(createTestDb());
      storage.close();
      expect(() => storage.close()).not.toThrow();
    });
  });
});
