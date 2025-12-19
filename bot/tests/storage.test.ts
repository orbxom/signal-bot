import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Storage } from '../src/storage';
import * as fs from 'fs';

describe('Storage', () => {
  const testDbPath = './test.db';

  afterEach(() => {
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  it('should initialize database with tables', () => {
    const storage = new Storage(testDbPath);
    try {
      expect(storage).toBeDefined();
    } finally {
      storage.close();
    }
  });

  it('should add and retrieve messages', () => {
    const storage = new Storage(testDbPath);

    storage.addMessage({
      groupId: 'group1',
      sender: 'Alice',
      content: 'Hello',
      timestamp: Date.now(),
      isBot: false
    });

    const messages = storage.getRecentMessages('group1', 10);
    expect(messages).toHaveLength(1);
    expect(messages[0].sender).toBe('Alice');
    expect(messages[0].content).toBe('Hello');

    storage.close();
  });

  it('should trim old messages beyond window size', () => {
    const storage = new Storage(testDbPath);
    const groupId = 'group1';

    // Add 25 messages
    for (let i = 0; i < 25; i++) {
      storage.addMessage({
        groupId,
        sender: 'User',
        content: `Message ${i}`,
        timestamp: Date.now() + i,
        isBot: false
      });
    }

    storage.trimMessages(groupId, 20);
    const messages = storage.getRecentMessages(groupId, 100);
    expect(messages).toHaveLength(20);
    expect(messages[0].content).toBe('Message 5');

    storage.close();
  });
});
