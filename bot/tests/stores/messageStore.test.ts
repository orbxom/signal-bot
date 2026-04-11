import { afterEach, describe, expect, it } from 'vitest';
import { MessageStore } from '../../src/stores/messageStore';
import { createTestDb, type TestDb } from '../helpers/testDb';

describe('MessageStore', () => {
  let db: TestDb;
  let store: MessageStore;

  const setup = () => {
    db = createTestDb('signal-bot-message-store-test-');
    store = new MessageStore(db.conn);
    return store;
  };

  afterEach(() => {
    db?.cleanup();
  });

  /** Helper to seed messages for a group */
  const seedMessages = (groupId: string, messages: Array<{ sender: string; content: string; timestamp: number }>) => {
    for (const msg of messages) {
      store.add({ groupId, sender: msg.sender, content: msg.content, timestamp: msg.timestamp, isBot: false });
    }
  };

  describe('add and getRecent', () => {
    it('should add and retrieve messages', () => {
      setup();
      store.add({
        groupId: 'group1',
        sender: 'Alice',
        content: 'Hello',
        timestamp: Date.now(),
        isBot: false,
      });

      const messages = store.getRecent('group1', 10);
      expect(messages).toHaveLength(1);
      expect(messages[0].sender).toBe('Alice');
      expect(messages[0].content).toBe('Hello');
    });

    it('should return messages in oldest-first order', () => {
      setup();
      store.add({ groupId: 'group1', sender: 'Alice', content: 'First', timestamp: 1000, isBot: false });
      store.add({ groupId: 'group1', sender: 'Bob', content: 'Second', timestamp: 2000, isBot: false });
      store.add({ groupId: 'group1', sender: 'Charlie', content: 'Third', timestamp: 3000, isBot: false });

      const messages = store.getRecent('group1', 10);
      expect(messages[0].content).toBe('First');
      expect(messages[1].content).toBe('Second');
      expect(messages[2].content).toBe('Third');
    });

    it('should reject empty groupId on add', () => {
      setup();
      expect(() =>
        store.add({ groupId: '', sender: 'Alice', content: 'Hello', timestamp: Date.now(), isBot: false }),
      ).toThrow('Invalid groupId: cannot be empty');
    });

    it('should reject empty groupId on getRecent', () => {
      setup();
      expect(() => store.getRecent('', 10)).toThrow('Invalid groupId: cannot be empty');
    });

    it('should reject limit <= 0 on getRecent', () => {
      setup();
      expect(() => store.getRecent('group1', 0)).toThrow('Invalid limit: must be greater than zero');
    });
  });

  describe('attachment storage', () => {
    it('should store and retrieve attachments', () => {
      setup();
      const attachments = [{ id: 'voice-abc', contentType: 'audio/aac', size: 5000, filename: null }];
      store.add({
        groupId: 'group1',
        sender: 'Alice',
        content: '',
        timestamp: Date.now(),
        isBot: false,
        attachments,
      });

      const messages = store.getRecent('group1', 10);
      expect(messages).toHaveLength(1);
      expect(messages[0].attachments).toEqual(attachments);
    });

    it('should return undefined attachments when none stored', () => {
      setup();
      store.add({ groupId: 'group1', sender: 'Alice', content: 'Hello', timestamp: Date.now(), isBot: false });

      const messages = store.getRecent('group1', 10);
      expect(messages[0].attachments).toBeUndefined();
    });

    it('should not store attachments when array is empty', () => {
      setup();
      store.add({
        groupId: 'group1',
        sender: 'Alice',
        content: 'Hello',
        timestamp: Date.now(),
        isBot: false,
        attachments: [],
      });

      const messages = store.getRecent('group1', 10);
      expect(messages[0].attachments).toBeUndefined();
    });
  });

  describe('trim', () => {
    it('should trim old messages beyond keepCount', () => {
      setup();
      for (let i = 0; i < 25; i++) {
        store.add({
          groupId: 'group1',
          sender: 'User',
          content: `Message ${i}`,
          timestamp: Date.now() + i,
          isBot: false,
        });
      }

      store.trim('group1', 20);
      const messages = store.getRecent('group1', 100);
      expect(messages).toHaveLength(20);
      expect(messages[0].content).toBe('Message 5');
    });

    it('should reject empty groupId', () => {
      setup();
      expect(() => store.trim('', 20)).toThrow('Invalid groupId: cannot be empty');
    });

    it('should reject keepCount <= 0', () => {
      setup();
      expect(() => store.trim('group1', 0)).toThrow('Invalid keepCount: must be greater than zero');
    });
  });

  describe('search', () => {
    it('should find messages matching a keyword', () => {
      setup();
      seedMessages('group1', [
        { sender: 'Alice', content: 'Hello world', timestamp: 1000 },
        { sender: 'Bob', content: 'Goodbye world', timestamp: 2000 },
        { sender: 'Alice', content: 'Nothing here', timestamp: 3000 },
      ]);

      const results = store.search('group1', 'world');
      expect(results).toHaveLength(2);
      expect(results[0].content).toBe('Hello world');
      expect(results[1].content).toBe('Goodbye world');
    });

    it('should be case insensitive', () => {
      setup();
      seedMessages('group1', [
        { sender: 'Alice', content: 'Hello World', timestamp: 1000 },
        { sender: 'Bob', content: 'hello world', timestamp: 2000 },
        { sender: 'Charlie', content: 'HELLO WORLD', timestamp: 3000 },
      ]);

      const results = store.search('group1', 'hello');
      expect(results).toHaveLength(3);
    });

    it('should filter by sender', () => {
      setup();
      seedMessages('group1', [
        { sender: 'Alice', content: 'I like pizza', timestamp: 1000 },
        { sender: 'Bob', content: 'I like pizza too', timestamp: 2000 },
        { sender: 'Alice', content: 'Pizza is great', timestamp: 3000 },
      ]);

      const results = store.search('group1', 'pizza', { sender: 'Alice' });
      expect(results).toHaveLength(2);
      expect(results.every(m => m.sender === 'Alice')).toBe(true);
    });

    it('should filter by date range', () => {
      setup();
      seedMessages('group1', [
        { sender: 'Alice', content: 'Early message about cats', timestamp: 1000 },
        { sender: 'Bob', content: 'Middle message about cats', timestamp: 2000 },
        { sender: 'Charlie', content: 'Late message about cats', timestamp: 3000 },
      ]);

      const results = store.search('group1', 'cats', { startTimestamp: 1500, endTimestamp: 2500 });
      expect(results).toHaveLength(1);
      expect(results[0].content).toBe('Middle message about cats');
    });

    it('should escape % in keyword', () => {
      setup();
      seedMessages('group1', [
        { sender: 'Alice', content: '100% complete', timestamp: 1000 },
        { sender: 'Bob', content: '100 complete', timestamp: 2000 },
      ]);

      const results = store.search('group1', '100%');
      expect(results).toHaveLength(1);
      expect(results[0].content).toBe('100% complete');
    });

    it('should escape _ in keyword', () => {
      setup();
      seedMessages('group1', [
        { sender: 'Alice', content: 'file_name.txt', timestamp: 1000 },
        { sender: 'Bob', content: 'filename.txt', timestamp: 2000 },
      ]);

      const results = store.search('group1', 'file_name');
      expect(results).toHaveLength(1);
      expect(results[0].content).toBe('file_name.txt');
    });

    it('should enforce limit', () => {
      setup();
      for (let i = 0; i < 10; i++) {
        store.add({
          groupId: 'group1',
          sender: 'Alice',
          content: `Message about topic ${i}`,
          timestamp: 1000 + i,
          isBot: false,
        });
      }

      const results = store.search('group1', 'topic', { limit: 5 });
      expect(results).toHaveLength(5);
    });

    it('should use default limit of 100', () => {
      setup();
      for (let i = 0; i < 110; i++) {
        store.add({
          groupId: 'group1',
          sender: 'Alice',
          content: `Repeated keyword ${i}`,
          timestamp: 1000 + i,
          isBot: false,
        });
      }

      const results = store.search('group1', 'keyword');
      expect(results).toHaveLength(100);
    });

    it('should return results in chronological order (ASC)', () => {
      setup();
      seedMessages('group1', [
        { sender: 'Alice', content: 'Third match', timestamp: 3000 },
        { sender: 'Bob', content: 'First match', timestamp: 1000 },
        { sender: 'Charlie', content: 'Second match', timestamp: 2000 },
      ]);

      const results = store.search('group1', 'match');
      expect(results[0].content).toBe('First match');
      expect(results[1].content).toBe('Second match');
      expect(results[2].content).toBe('Third match');
    });

    it('should reject empty groupId', () => {
      setup();
      expect(() => store.search('', 'test')).toThrow('Invalid groupId: cannot be empty');
    });

    it('should reject empty keyword', () => {
      setup();
      expect(() => store.search('group1', '')).toThrow('Invalid keyword: cannot be empty');
    });

    it('should reject limit of zero', () => {
      setup();
      expect(() => store.search('group1', 'test', { limit: 0 })).toThrow('Invalid limit: must be greater than zero');
    });

    it('should correctly map isBot field', () => {
      setup();
      store.add({
        groupId: 'group1',
        sender: 'Bot',
        content: 'Bot response about topic',
        timestamp: 1000,
        isBot: true,
      });
      store.add({
        groupId: 'group1',
        sender: 'Alice',
        content: 'Human message about topic',
        timestamp: 2000,
        isBot: false,
      });

      const results = store.search('group1', 'topic');
      expect(results[0].isBot).toBe(true);
      expect(results[1].isBot).toBe(false);
    });
  });

  describe('getByDateRange', () => {
    it('should retrieve messages within a timestamp range', () => {
      setup();
      seedMessages('group1', [
        { sender: 'Alice', content: 'Before range', timestamp: 500 },
        { sender: 'Bob', content: 'In range 1', timestamp: 1000 },
        { sender: 'Charlie', content: 'In range 2', timestamp: 1500 },
        { sender: 'Dave', content: 'After range', timestamp: 2500 },
      ]);

      const results = store.getByDateRange('group1', 1000, 2000);
      expect(results).toHaveLength(2);
      expect(results[0].content).toBe('In range 1');
      expect(results[1].content).toBe('In range 2');
    });

    it('should include boundary timestamps', () => {
      setup();
      seedMessages('group1', [
        { sender: 'Alice', content: 'Start boundary', timestamp: 1000 },
        { sender: 'Bob', content: 'Middle', timestamp: 1500 },
        { sender: 'Charlie', content: 'End boundary', timestamp: 2000 },
      ]);

      const results = store.getByDateRange('group1', 1000, 2000);
      expect(results).toHaveLength(3);
    });

    it('should return results in chronological order', () => {
      setup();
      seedMessages('group1', [
        { sender: 'Charlie', content: 'Third', timestamp: 3000 },
        { sender: 'Alice', content: 'First', timestamp: 1000 },
        { sender: 'Bob', content: 'Second', timestamp: 2000 },
      ]);

      const results = store.getByDateRange('group1', 1000, 3000);
      expect(results[0].content).toBe('First');
      expect(results[1].content).toBe('Second');
      expect(results[2].content).toBe('Third');
    });

    it('should enforce limit', () => {
      setup();
      for (let i = 0; i < 10; i++) {
        store.add({
          groupId: 'group1',
          sender: 'Alice',
          content: `Message ${i}`,
          timestamp: 1000 + i,
          isBot: false,
        });
      }

      const results = store.getByDateRange('group1', 1000, 2000, 5);
      expect(results).toHaveLength(5);
    });

    it('should use default limit of 200', () => {
      setup();
      for (let i = 0; i < 210; i++) {
        store.add({
          groupId: 'group1',
          sender: 'Alice',
          content: `Message ${i}`,
          timestamp: 1000 + i,
          isBot: false,
        });
      }

      const results = store.getByDateRange('group1', 0, 999999);
      expect(results).toHaveLength(200);
    });

    it('should reject empty groupId', () => {
      setup();
      expect(() => store.getByDateRange('', 1000, 2000)).toThrow('Invalid groupId: cannot be empty');
    });

    it('should reject limit of zero', () => {
      setup();
      expect(() => store.getByDateRange('group1', 1000, 2000, 0)).toThrow('Invalid limit: must be greater than zero');
    });
  });

  describe('getCount', () => {
    it('should return 0 for unknown group', () => {
      setup();
      expect(store.getCount('nonexistent')).toBe(0);
    });

    it('should return count of messages for a group', () => {
      setup();
      seedMessages('group1', [
        { sender: 'Alice', content: 'One', timestamp: 1000 },
        { sender: 'Bob', content: 'Two', timestamp: 2000 },
        { sender: 'Charlie', content: 'Three', timestamp: 3000 },
      ]);
      seedMessages('group2', [
        { sender: 'Alice', content: 'Other', timestamp: 1000 },
      ]);

      expect(store.getCount('group1')).toBe(3);
      expect(store.getCount('group2')).toBe(1);
    });
  });

  describe('getLastTimestamp', () => {
    it('should return null for unknown group', () => {
      setup();
      expect(store.getLastTimestamp('nonexistent')).toBeNull();
    });

    it('should return the max timestamp for a group', () => {
      setup();
      seedMessages('group1', [
        { sender: 'Alice', content: 'First', timestamp: 1000 },
        { sender: 'Bob', content: 'Last', timestamp: 3000 },
        { sender: 'Charlie', content: 'Middle', timestamp: 2000 },
      ]);

      expect(store.getLastTimestamp('group1')).toBe(3000);
    });

    it('should only return timestamp for the specified group', () => {
      setup();
      seedMessages('group1', [
        { sender: 'Alice', content: 'Old', timestamp: 1000 },
      ]);
      seedMessages('group2', [
        { sender: 'Bob', content: 'New', timestamp: 5000 },
      ]);

      expect(store.getLastTimestamp('group1')).toBe(1000);
    });
  });

  describe('getDistinctGroupIds', () => {
    it('should return empty array when no messages exist', () => {
      setup();
      expect(store.getDistinctGroupIds()).toEqual([]);
    });

    it('should return distinct group IDs from messages', () => {
      setup();
      const now = Date.now();
      store.add({ groupId: 'group1', sender: 'Alice', content: 'Hi', timestamp: now, isBot: false });
      store.add({ groupId: 'group2', sender: 'Bob', content: 'Hey', timestamp: now + 1, isBot: false });
      store.add({ groupId: 'group1', sender: 'Alice', content: 'Again', timestamp: now + 2, isBot: false });

      const groupIds = store.getDistinctGroupIds();
      expect(groupIds).toHaveLength(2);
      expect(groupIds).toContain('group1');
      expect(groupIds).toContain('group2');
    });

    it('should include groups with only bot messages', () => {
      setup();
      store.add({ groupId: 'group1', sender: 'bot', content: 'Hello', timestamp: Date.now(), isBot: true });
      expect(store.getDistinctGroupIds()).toEqual(['group1']);
    });
  });
});
