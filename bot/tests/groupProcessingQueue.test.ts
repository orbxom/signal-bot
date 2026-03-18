import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GroupProcessingQueue } from '../src/groupProcessingQueue';
import type { QueueItem } from '../src/types';

vi.mock('../src/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    compact: vi.fn(),
  },
}));

function singleItem(groupId: string, overrides?: Partial<{ sender: string; content: string; timestamp: number }>): QueueItem {
  return {
    kind: 'single',
    request: {
      groupId,
      sender: overrides?.sender ?? 'Alice',
      content: overrides?.content ?? '@bot hello',
      attachments: [],
      timestamp: overrides?.timestamp ?? Date.now(),
    },
  };
}

describe('GroupProcessingQueue', () => {
  let processed: QueueItem[];
  let processCallback: (item: QueueItem) => Promise<void>;
  let queue: GroupProcessingQueue;

  beforeEach(() => {
    vi.clearAllMocks();
    processed = [];
    processCallback = async (item: QueueItem) => {
      processed.push(item);
    };
    queue = new GroupProcessingQueue(processCallback);
  });

  afterEach(() => {
    queue.shutdown();
  });

  it('should process a single enqueued item', async () => {
    const item = singleItem('g1');
    queue.enqueue(item);

    await vi.waitFor(() => {
      expect(processed).toHaveLength(1);
    });
    expect(processed[0]).toBe(item);
  });

  it('should process items FIFO within the same group', async () => {
    const slow = async (item: QueueItem) => {
      await new Promise(r => setTimeout(r, 10));
      processed.push(item);
    };
    queue = new GroupProcessingQueue(slow);

    const item1 = singleItem('g1', { content: 'first' });
    const item2 = singleItem('g1', { content: 'second' });
    queue.enqueue(item1);
    queue.enqueue(item2);

    await vi.waitFor(() => {
      expect(processed).toHaveLength(2);
    });
    expect(processed[0]).toBe(item1);
    expect(processed[1]).toBe(item2);
  });

  it('should serialize processing within the same group', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    const trackConcurrency = async (item: QueueItem) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise(r => setTimeout(r, 20));
      concurrent--;
      processed.push(item);
    };
    queue = new GroupProcessingQueue(trackConcurrency);

    queue.enqueue(singleItem('g1', { content: 'a' }));
    queue.enqueue(singleItem('g1', { content: 'b' }));
    queue.enqueue(singleItem('g1', { content: 'c' }));

    await vi.waitFor(() => {
      expect(processed).toHaveLength(3);
    });
    expect(maxConcurrent).toBe(1);
  });

  it('should allow different groups to process concurrently', async () => {
    const order: string[] = [];
    const slow = async (item: QueueItem) => {
      const id = item.kind === 'single' ? item.request.groupId : item.requests[0].groupId;
      order.push(`start:${id}`);
      await new Promise(r => setTimeout(r, 30));
      order.push(`end:${id}`);
    };
    queue = new GroupProcessingQueue(slow);

    queue.enqueue(singleItem('g1'));
    queue.enqueue(singleItem('g2'));

    await vi.waitFor(() => {
      expect(order.filter(o => o.startsWith('end:'))).toHaveLength(2);
    });

    const startG1 = order.indexOf('start:g1');
    const startG2 = order.indexOf('start:g2');
    const endG1 = order.indexOf('end:g1');
    const endG2 = order.indexOf('end:g2');
    expect(startG1).toBeLessThan(endG1);
    expect(startG2).toBeLessThan(endG2);
    expect(startG1).toBeLessThan(endG2);
    expect(startG2).toBeLessThan(endG1);
  });

  it('should report processing state per group', async () => {
    let resolveProcessing: () => void;
    const blockingCallback = async () => {
      await new Promise<void>(r => { resolveProcessing = r; });
    };
    queue = new GroupProcessingQueue(blockingCallback);

    expect(queue.isProcessing('g1')).toBe(false);

    queue.enqueue(singleItem('g1'));
    await new Promise(r => setTimeout(r, 0));

    expect(queue.isProcessing('g1')).toBe(true);
    expect(queue.isProcessing('g2')).toBe(false);
    expect(queue.getPendingCount('g1')).toBe(0);

    resolveProcessing!();
    await vi.waitFor(() => {
      expect(queue.isProcessing('g1')).toBe(false);
    });
  });

  describe('TTL safety valve', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should release lock and move to next item when TTL expires', async () => {
      const results: string[] = [];
      const callback = async (item: QueueItem) => {
        const content = item.kind === 'single' ? item.request.content : 'coalesced';
        if (content === 'hang') {
          await new Promise(() => {}); // never resolves
        }
        results.push(content);
      };
      queue = new GroupProcessingQueue(callback, { ttlMs: 1000 });

      queue.enqueue(singleItem('g1', { content: 'hang' }));
      queue.enqueue(singleItem('g1', { content: 'second' }));

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(0);

      expect(results).toContain('second');
    });
  });

  describe('queue cap', () => {
    it('should drop new items when queue is full', () => {
      const callback = async () => {
        await new Promise(() => {}); // block forever
      };
      queue = new GroupProcessingQueue(callback, { maxQueueSize: 2 });

      queue.enqueue(singleItem('g1', { content: 'processing' }));
      queue.enqueue(singleItem('g1', { content: 'queued1' }));
      queue.enqueue(singleItem('g1', { content: 'queued2' }));
      queue.enqueue(singleItem('g1', { content: 'dropped' }));

      expect(queue.getPendingCount('g1')).toBe(2);
    });
  });

  describe('shutdown', () => {
    it('should stop accepting new items after shutdown', () => {
      queue.shutdown();
      queue.enqueue(singleItem('g1'));

      expect(queue.isProcessing('g1')).toBe(false);
      expect(queue.getPendingCount('g1')).toBe(0);
    });

    it('should clear pending queues on shutdown', async () => {
      const callback = async () => {
        await new Promise(() => {}); // block forever
      };
      queue = new GroupProcessingQueue(callback);

      queue.enqueue(singleItem('g1', { content: 'processing' }));
      queue.enqueue(singleItem('g1', { content: 'pending' }));

      await new Promise(r => setTimeout(r, 0));

      expect(queue.getPendingCount('g1')).toBe(1);

      queue.shutdown();
      expect(queue.getPendingCount('g1')).toBe(0);
    });
  });
});
