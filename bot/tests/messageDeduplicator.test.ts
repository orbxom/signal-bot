import { describe, expect, it } from 'vitest';
import { MessageDeduplicator } from '../src/messageDeduplicator';

describe('MessageDeduplicator', () => {
  it('should return false for first-seen message', () => {
    const dedup = new MessageDeduplicator();
    expect(dedup.isDuplicate('g1', 'Alice', 1000)).toBe(false);
  });

  it('should return true for duplicate (same group/sender/timestamp)', () => {
    const dedup = new MessageDeduplicator();
    dedup.isDuplicate('g1', 'Alice', 1000);
    expect(dedup.isDuplicate('g1', 'Alice', 1000)).toBe(true);
  });

  it('should return false for different group', () => {
    const dedup = new MessageDeduplicator();
    dedup.isDuplicate('g1', 'Alice', 1000);
    expect(dedup.isDuplicate('g2', 'Alice', 1000)).toBe(false);
  });

  it('should return false for different sender', () => {
    const dedup = new MessageDeduplicator();
    dedup.isDuplicate('g1', 'Alice', 1000);
    expect(dedup.isDuplicate('g1', 'Bob', 1000)).toBe(false);
  });

  it('should return false for different timestamp', () => {
    const dedup = new MessageDeduplicator();
    dedup.isDuplicate('g1', 'Alice', 1000);
    expect(dedup.isDuplicate('g1', 'Alice', 2000)).toBe(false);
  });

  it('should evict oldest at capacity (one at a time, no cliff)', () => {
    const dedup = new MessageDeduplicator(3);

    dedup.isDuplicate('g1', 'a', 1); // entry 1
    dedup.isDuplicate('g1', 'a', 2); // entry 2
    dedup.isDuplicate('g1', 'a', 3); // entry 3

    // At capacity 3, adding a 4th should evict the oldest (entry 1)
    dedup.isDuplicate('g1', 'a', 4); // entry 4, evicts entry 1

    // Entries 2-4 should still be present (check these first to avoid cascading eviction)
    expect(dedup.isDuplicate('g1', 'a', 2)).toBe(true);
    expect(dedup.isDuplicate('g1', 'a', 3)).toBe(true);
    expect(dedup.isDuplicate('g1', 'a', 4)).toBe(true);

    // Entry 1 was evicted — checking it re-inserts it (returns false)
    expect(dedup.isDuplicate('g1', 'a', 1)).toBe(false);
  });

  it('should handle capacity of 1', () => {
    const dedup = new MessageDeduplicator(1);

    dedup.isDuplicate('g1', 'a', 1);
    expect(dedup.isDuplicate('g1', 'a', 1)).toBe(true);

    // Adding a second entry should evict the first
    dedup.isDuplicate('g1', 'a', 2);
    // Check entry 2 first (still present)
    expect(dedup.isDuplicate('g1', 'a', 2)).toBe(true);

    // Use a fresh deduplicator to verify eviction without cascading re-insert
    const dedup2 = new MessageDeduplicator(1);
    dedup2.isDuplicate('g1', 'a', 1);
    dedup2.isDuplicate('g1', 'a', 2); // evicts entry 1
    // Entry 1 was evicted, so it's "new" again
    expect(dedup2.isDuplicate('g1', 'a', 1)).toBe(false);
  });
});
