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
});
