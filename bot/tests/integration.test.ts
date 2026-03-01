import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MessageHandler } from '../src/messageHandler';
import { Storage } from '../src/storage';

describe('Integration Tests', () => {
  let testDir: string;
  let storage: Storage;

  beforeAll(() => {
    testDir = mkdtempSync(join(tmpdir(), 'signal-bot-integration-'));
    storage = new Storage(join(testDir, 'test.db'));
  });

  afterAll(() => {
    storage.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('Full message flow with storage', () => {
    const groupId = 'integration-test-group';

    it('should store and retrieve conversation history', () => {
      storage.addMessage({
        groupId,
        sender: 'Alice',
        content: 'Hello everyone',
        timestamp: Date.now() - 3000,
        isBot: false,
      });

      storage.addMessage({
        groupId,
        sender: 'Bob',
        content: '@bot what is 2+2?',
        timestamp: Date.now() - 2000,
        isBot: false,
      });

      const messages = storage.getRecentMessages(groupId, 10);
      expect(messages).toHaveLength(2);
      expect(messages[0].sender).toBe('Alice');
      expect(messages[1].sender).toBe('Bob');
    });

    it('should detect mentions and extract queries', () => {
      const handler = new MessageHandler(['@bot', 'bot:']);

      expect(handler.isMentioned('@bot what is 2+2?')).toBe(true);
      expect(handler.isMentioned('Hello everyone')).toBe(false);

      const query = handler.extractQuery('@bot what is 2+2?');
      expect(query).toBe('what is 2+2?');
    });

    it('should build context from stored history', () => {
      const handler = new MessageHandler(['@bot'], { systemPrompt: 'You are a helpful family assistant.' });

      const history = storage.getRecentMessages(groupId, 10);
      const context = handler.buildContext(history, 'what is 2+2?');

      expect(context[0].role).toBe('system');
      expect(context[0].content).toContain('helpful family assistant');
      expect(context.length).toBeGreaterThan(2);

      const lastMsg = context[context.length - 1];
      expect(lastMsg.role).toBe('user');
      expect(lastMsg.content).toBe('what is 2+2?');
    });

    it('should include bot messages as assistant role in context', () => {
      storage.addMessage({
        groupId,
        sender: 'bot',
        content: '2+2 equals 4!',
        timestamp: Date.now() - 1000,
        isBot: true,
      });

      const handler = new MessageHandler(['@bot']);
      const history = storage.getRecentMessages(groupId, 10);
      const context = handler.buildContext(history, 'thanks!');

      const assistantMessages = context.filter(m => m.role === 'assistant');
      expect(assistantMessages.length).toBeGreaterThan(0);
      expect(assistantMessages[0].content).toBe('2+2 equals 4!');
    });
  });

  describe('Sliding window management', () => {
    const groupId = 'window-test-group';

    it('should maintain sliding window of messages', () => {
      for (let i = 0; i < 25; i++) {
        storage.addMessage({
          groupId,
          sender: `User${i}`,
          content: `Message ${i}`,
          timestamp: Date.now() + i,
          isBot: i % 3 === 0,
        });
      }

      storage.trimMessages(groupId, 20);

      const messages = storage.getRecentMessages(groupId, 100);
      expect(messages).toHaveLength(20);
      expect(messages[0].content).toBe('Message 5');
      expect(messages[19].content).toBe('Message 24');
    });

    it('should preserve most recent messages when trimming', () => {
      for (let i = 25; i < 35; i++) {
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
      expect(messages[messages.length - 1].content).toBe('Message 34');
    });
  });

  describe('Multi-group isolation', () => {
    it('should keep messages separate per group', () => {
      const group1 = 'isolation-group-1';
      const group2 = 'isolation-group-2';

      storage.addMessage({
        groupId: group1,
        sender: 'Alice',
        content: 'Hello from group 1',
        timestamp: Date.now(),
        isBot: false,
      });

      storage.addMessage({
        groupId: group2,
        sender: 'Bob',
        content: 'Hello from group 2',
        timestamp: Date.now(),
        isBot: false,
      });

      const group1Messages = storage.getRecentMessages(group1, 10);
      const group2Messages = storage.getRecentMessages(group2, 10);

      expect(group1Messages).toHaveLength(1);
      expect(group1Messages[0].content).toBe('Hello from group 1');
      expect(group2Messages).toHaveLength(1);
      expect(group2Messages[0].content).toBe('Hello from group 2');
    });
  });
});
