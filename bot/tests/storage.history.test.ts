import { afterEach, describe, expect, it } from 'vitest';
import { createTestStorage, type TestStorage } from './helpers/testDb';

describe('Storage - History Search', () => {
  let ts: TestStorage;

  const createStorage = () => {
    ts = createTestStorage('signal-bot-history-test-');
    return ts.storage;
  };

  afterEach(() => {
    ts?.cleanup();
  });

  /** Helper to seed messages for a group */
  const seedMessages = (groupId: string, messages: Array<{ sender: string; content: string; timestamp: number }>) => {
    for (const msg of messages) {
      ts.storage.addMessage({
        groupId,
        sender: msg.sender,
        content: msg.content,
        timestamp: msg.timestamp,
        isBot: false,
      });
    }
  };

  describe('searchMessages', () => {
    it('should find messages matching a keyword', () => {
      createStorage();
      seedMessages('group1', [
        { sender: 'Alice', content: 'Hello world', timestamp: 1000 },
        { sender: 'Bob', content: 'Goodbye world', timestamp: 2000 },
        { sender: 'Alice', content: 'Nothing here', timestamp: 3000 },
      ]);

      const results = ts.storage.searchMessages('group1', 'world');
      expect(results).toHaveLength(2);
      expect(results[0].content).toBe('Hello world');
      expect(results[1].content).toBe('Goodbye world');
    });

    it('should be case insensitive (SQLite LIKE default behavior)', () => {
      createStorage();
      seedMessages('group1', [
        { sender: 'Alice', content: 'Hello World', timestamp: 1000 },
        { sender: 'Bob', content: 'hello world', timestamp: 2000 },
        { sender: 'Charlie', content: 'HELLO WORLD', timestamp: 3000 },
      ]);

      const results = ts.storage.searchMessages('group1', 'hello');
      expect(results).toHaveLength(3);
    });

    it('should filter by sender when provided', () => {
      createStorage();
      seedMessages('group1', [
        { sender: 'Alice', content: 'I like pizza', timestamp: 1000 },
        { sender: 'Bob', content: 'I like pizza too', timestamp: 2000 },
        { sender: 'Alice', content: 'Pizza is great', timestamp: 3000 },
      ]);

      const results = ts.storage.searchMessages('group1', 'pizza', { sender: 'Alice' });
      expect(results).toHaveLength(2);
      expect(results.every(m => m.sender === 'Alice')).toBe(true);
    });

    it('should filter by date range when provided', () => {
      createStorage();
      seedMessages('group1', [
        { sender: 'Alice', content: 'Early message about cats', timestamp: 1000 },
        { sender: 'Bob', content: 'Middle message about cats', timestamp: 2000 },
        { sender: 'Charlie', content: 'Late message about cats', timestamp: 3000 },
      ]);

      const results = ts.storage.searchMessages('group1', 'cats', {
        startTimestamp: 1500,
        endTimestamp: 2500,
      });
      expect(results).toHaveLength(1);
      expect(results[0].content).toBe('Middle message about cats');
    });

    it('should apply combined filters (sender + date range)', () => {
      createStorage();
      seedMessages('group1', [
        { sender: 'Alice', content: 'Alice early cats', timestamp: 1000 },
        { sender: 'Bob', content: 'Bob early cats', timestamp: 1500 },
        { sender: 'Alice', content: 'Alice late cats', timestamp: 2000 },
        { sender: 'Bob', content: 'Bob late cats', timestamp: 2500 },
      ]);

      const results = ts.storage.searchMessages('group1', 'cats', {
        sender: 'Alice',
        startTimestamp: 1500,
        endTimestamp: 2500,
      });
      expect(results).toHaveLength(1);
      expect(results[0].content).toBe('Alice late cats');
    });

    it('should return empty array when no matches', () => {
      createStorage();
      seedMessages('group1', [{ sender: 'Alice', content: 'Hello world', timestamp: 1000 }]);

      const results = ts.storage.searchMessages('group1', 'nonexistent');
      expect(results).toEqual([]);
    });

    it('should return empty array for empty group', () => {
      createStorage();
      const results = ts.storage.searchMessages('group1', 'anything');
      expect(results).toEqual([]);
    });

    it('should escape % in keyword', () => {
      createStorage();
      seedMessages('group1', [
        { sender: 'Alice', content: '100% complete', timestamp: 1000 },
        { sender: 'Bob', content: '100 complete', timestamp: 2000 },
      ]);

      const results = ts.storage.searchMessages('group1', '100%');
      expect(results).toHaveLength(1);
      expect(results[0].content).toBe('100% complete');
    });

    it('should escape _ in keyword', () => {
      createStorage();
      seedMessages('group1', [
        { sender: 'Alice', content: 'file_name.txt', timestamp: 1000 },
        { sender: 'Bob', content: 'filename.txt', timestamp: 2000 },
      ]);

      const results = ts.storage.searchMessages('group1', 'file_name');
      expect(results).toHaveLength(1);
      expect(results[0].content).toBe('file_name.txt');
    });

    it('should escape backslash in keyword', () => {
      createStorage();
      seedMessages('group1', [
        { sender: 'Alice', content: 'path\\to\\file', timestamp: 1000 },
        { sender: 'Bob', content: 'pathtofile', timestamp: 2000 },
      ]);

      const results = ts.storage.searchMessages('group1', 'path\\to');
      expect(results).toHaveLength(1);
      expect(results[0].content).toBe('path\\to\\file');
    });

    it('should enforce limit', () => {
      createStorage();
      for (let i = 0; i < 10; i++) {
        ts.storage.addMessage({
          groupId: 'group1',
          sender: 'Alice',
          content: `Message about topic ${i}`,
          timestamp: 1000 + i,
          isBot: false,
        });
      }

      const results = ts.storage.searchMessages('group1', 'topic', { limit: 5 });
      expect(results).toHaveLength(5);
    });

    it('should use default limit of 100', () => {
      createStorage();
      for (let i = 0; i < 110; i++) {
        ts.storage.addMessage({
          groupId: 'group1',
          sender: 'Alice',
          content: `Repeated keyword ${i}`,
          timestamp: 1000 + i,
          isBot: false,
        });
      }

      const results = ts.storage.searchMessages('group1', 'keyword');
      expect(results).toHaveLength(100);
    });

    it('should return results in chronological order (ASC)', () => {
      createStorage();
      seedMessages('group1', [
        { sender: 'Alice', content: 'Third match', timestamp: 3000 },
        { sender: 'Bob', content: 'First match', timestamp: 1000 },
        { sender: 'Charlie', content: 'Second match', timestamp: 2000 },
      ]);

      const results = ts.storage.searchMessages('group1', 'match');
      expect(results).toHaveLength(3);
      expect(results[0].content).toBe('First match');
      expect(results[1].content).toBe('Second match');
      expect(results[2].content).toBe('Third match');
    });

    it('should only search within the specified group', () => {
      createStorage();
      seedMessages('group1', [{ sender: 'Alice', content: 'Hello from group1', timestamp: 1000 }]);
      seedMessages('group2', [{ sender: 'Bob', content: 'Hello from group2', timestamp: 2000 }]);

      const results = ts.storage.searchMessages('group1', 'Hello');
      expect(results).toHaveLength(1);
      expect(results[0].content).toBe('Hello from group1');
    });

    it('should match keyword appearing anywhere in message', () => {
      createStorage();
      seedMessages('group1', [
        { sender: 'Alice', content: 'start keyword end', timestamp: 1000 },
        { sender: 'Bob', content: 'keyword at start', timestamp: 2000 },
        { sender: 'Charlie', content: 'at the end keyword', timestamp: 3000 },
      ]);

      const results = ts.storage.searchMessages('group1', 'keyword');
      expect(results).toHaveLength(3);
    });

    it('should include boundary timestamps (>=, <=)', () => {
      createStorage();
      seedMessages('group1', [
        { sender: 'Alice', content: 'boundary test', timestamp: 1000 },
        { sender: 'Bob', content: 'boundary test', timestamp: 2000 },
        { sender: 'Charlie', content: 'boundary test', timestamp: 3000 },
      ]);

      const results = ts.storage.searchMessages('group1', 'boundary', {
        startTimestamp: 1000,
        endTimestamp: 3000,
      });
      expect(results).toHaveLength(3);
    });

    it('should correctly map isBot field', () => {
      createStorage();
      ts.storage.addMessage({
        groupId: 'group1',
        sender: 'Bot',
        content: 'Bot response about topic',
        timestamp: 1000,
        isBot: true,
      });
      ts.storage.addMessage({
        groupId: 'group1',
        sender: 'Alice',
        content: 'Human message about topic',
        timestamp: 2000,
        isBot: false,
      });

      const results = ts.storage.searchMessages('group1', 'topic');
      expect(results).toHaveLength(2);
      expect(results[0].isBot).toBe(true);
      expect(results[1].isBot).toBe(false);
    });

    describe('validation', () => {
      it('should reject empty groupId', () => {
        createStorage();
        expect(() => ts.storage.searchMessages('', 'test')).toThrow('Invalid groupId: cannot be empty');
      });

      it('should reject whitespace-only groupId', () => {
        createStorage();
        expect(() => ts.storage.searchMessages('  ', 'test')).toThrow('Invalid groupId: cannot be empty');
      });

      it('should reject empty keyword', () => {
        createStorage();
        expect(() => ts.storage.searchMessages('group1', '')).toThrow('Invalid keyword: cannot be empty');
      });

      it('should reject whitespace-only keyword', () => {
        createStorage();
        expect(() => ts.storage.searchMessages('group1', '  ')).toThrow('Invalid keyword: cannot be empty');
      });

      it('should reject limit of zero', () => {
        createStorage();
        expect(() => ts.storage.searchMessages('group1', 'test', { limit: 0 })).toThrow(
          'Invalid limit: must be greater than zero',
        );
      });

      it('should reject negative limit', () => {
        createStorage();
        expect(() => ts.storage.searchMessages('group1', 'test', { limit: -1 })).toThrow(
          'Invalid limit: must be greater than zero',
        );
      });
    });

    describe('close guard', () => {
      it('should throw when database is closed', () => {
        createStorage();
        ts.storage.close();
        expect(() => ts.storage.searchMessages('group1', 'test')).toThrow('Database is closed');
      });
    });
  });

  describe('getMessagesByDateRange', () => {
    it('should retrieve messages within a timestamp range', () => {
      createStorage();
      seedMessages('group1', [
        { sender: 'Alice', content: 'Before range', timestamp: 500 },
        { sender: 'Bob', content: 'In range 1', timestamp: 1000 },
        { sender: 'Charlie', content: 'In range 2', timestamp: 1500 },
        { sender: 'Dave', content: 'After range', timestamp: 2500 },
      ]);

      const results = ts.storage.getMessagesByDateRange('group1', 1000, 2000);
      expect(results).toHaveLength(2);
      expect(results[0].content).toBe('In range 1');
      expect(results[1].content).toBe('In range 2');
    });

    it('should include boundary timestamps (>=, <=)', () => {
      createStorage();
      seedMessages('group1', [
        { sender: 'Alice', content: 'Start boundary', timestamp: 1000 },
        { sender: 'Bob', content: 'Middle', timestamp: 1500 },
        { sender: 'Charlie', content: 'End boundary', timestamp: 2000 },
      ]);

      const results = ts.storage.getMessagesByDateRange('group1', 1000, 2000);
      expect(results).toHaveLength(3);
    });

    it('should return results in chronological order (ASC)', () => {
      createStorage();
      seedMessages('group1', [
        { sender: 'Charlie', content: 'Third', timestamp: 3000 },
        { sender: 'Alice', content: 'First', timestamp: 1000 },
        { sender: 'Bob', content: 'Second', timestamp: 2000 },
      ]);

      const results = ts.storage.getMessagesByDateRange('group1', 1000, 3000);
      expect(results).toHaveLength(3);
      expect(results[0].content).toBe('First');
      expect(results[1].content).toBe('Second');
      expect(results[2].content).toBe('Third');
    });

    it('should return empty array when no messages in range', () => {
      createStorage();
      seedMessages('group1', [{ sender: 'Alice', content: 'Outside range', timestamp: 500 }]);

      const results = ts.storage.getMessagesByDateRange('group1', 1000, 2000);
      expect(results).toEqual([]);
    });

    it('should return empty array for empty group', () => {
      createStorage();
      const results = ts.storage.getMessagesByDateRange('group1', 1000, 2000);
      expect(results).toEqual([]);
    });

    it('should only retrieve messages from the specified group', () => {
      createStorage();
      seedMessages('group1', [{ sender: 'Alice', content: 'Group 1 message', timestamp: 1500 }]);
      seedMessages('group2', [{ sender: 'Bob', content: 'Group 2 message', timestamp: 1500 }]);

      const results = ts.storage.getMessagesByDateRange('group1', 1000, 2000);
      expect(results).toHaveLength(1);
      expect(results[0].content).toBe('Group 1 message');
    });

    it('should enforce limit', () => {
      createStorage();
      for (let i = 0; i < 10; i++) {
        ts.storage.addMessage({
          groupId: 'group1',
          sender: 'Alice',
          content: `Message ${i}`,
          timestamp: 1000 + i,
          isBot: false,
        });
      }

      const results = ts.storage.getMessagesByDateRange('group1', 1000, 2000, 5);
      expect(results).toHaveLength(5);
    });

    it('should use default limit of 200', () => {
      createStorage();
      for (let i = 0; i < 210; i++) {
        ts.storage.addMessage({
          groupId: 'group1',
          sender: 'Alice',
          content: `Message ${i}`,
          timestamp: 1000 + i,
          isBot: false,
        });
      }

      const results = ts.storage.getMessagesByDateRange('group1', 0, 999999);
      expect(results).toHaveLength(200);
    });

    it('should return earliest messages when limit truncates', () => {
      createStorage();
      for (let i = 0; i < 10; i++) {
        ts.storage.addMessage({
          groupId: 'group1',
          sender: 'Alice',
          content: `Message ${i}`,
          timestamp: 1000 + i,
          isBot: false,
        });
      }

      const results = ts.storage.getMessagesByDateRange('group1', 1000, 2000, 3);
      expect(results).toHaveLength(3);
      expect(results[0].content).toBe('Message 0');
      expect(results[1].content).toBe('Message 1');
      expect(results[2].content).toBe('Message 2');
    });

    it('should correctly map isBot field', () => {
      createStorage();
      ts.storage.addMessage({
        groupId: 'group1',
        sender: 'Bot',
        content: 'Bot reply',
        timestamp: 1500,
        isBot: true,
      });
      ts.storage.addMessage({
        groupId: 'group1',
        sender: 'Alice',
        content: 'Human message',
        timestamp: 1600,
        isBot: false,
      });

      const results = ts.storage.getMessagesByDateRange('group1', 1000, 2000);
      expect(results).toHaveLength(2);
      expect(results[0].isBot).toBe(true);
      expect(results[1].isBot).toBe(false);
    });

    it('should return empty when startTs > endTs', () => {
      createStorage();
      seedMessages('group1', [{ sender: 'Alice', content: 'A message', timestamp: 1500 }]);

      const results = ts.storage.getMessagesByDateRange('group1', 2000, 1000);
      expect(results).toEqual([]);
    });

    describe('validation', () => {
      it('should reject empty groupId', () => {
        createStorage();
        expect(() => ts.storage.getMessagesByDateRange('', 1000, 2000)).toThrow('Invalid groupId: cannot be empty');
      });

      it('should reject whitespace-only groupId', () => {
        createStorage();
        expect(() => ts.storage.getMessagesByDateRange('  ', 1000, 2000)).toThrow('Invalid groupId: cannot be empty');
      });

      it('should reject limit of zero', () => {
        createStorage();
        expect(() => ts.storage.getMessagesByDateRange('group1', 1000, 2000, 0)).toThrow(
          'Invalid limit: must be greater than zero',
        );
      });

      it('should reject negative limit', () => {
        createStorage();
        expect(() => ts.storage.getMessagesByDateRange('group1', 1000, 2000, -1)).toThrow(
          'Invalid limit: must be greater than zero',
        );
      });
    });

    describe('close guard', () => {
      it('should throw when database is closed', () => {
        createStorage();
        ts.storage.close();
        expect(() => ts.storage.getMessagesByDateRange('group1', 1000, 2000)).toThrow('Database is closed');
      });
    });
  });
});
