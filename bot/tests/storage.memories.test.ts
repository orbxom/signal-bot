import { afterEach, describe, expect, it } from 'vitest';
import { createTestStorage, type TestStorage } from './helpers/testDb';

describe('Storage - Memories', () => {
  let ts: TestStorage;

  afterEach(() => {
    ts?.cleanup();
  });

  it('should access memory store for group queries', () => {
    ts = createTestStorage();
    ts.storage.memories.save('group1', 'Pizza', 'url', { content: 'http://example.com' });
    const memories = ts.storage.getMemoriesByGroup('group1');
    expect(memories).toHaveLength(1);
    expect(memories[0].title).toBe('Pizza');
  });

  it('should return empty array for group with no memories', () => {
    ts = createTestStorage();
    const memories = ts.storage.getMemoriesByGroup('group1');
    expect(memories).toEqual([]);
  });
});
