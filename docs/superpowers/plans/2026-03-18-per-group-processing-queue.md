# Per-Group Processing Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serialize Claude invocations per Signal group to prevent duplicate/contradictory responses when multiple people invoke the bot concurrently.

**Architecture:** A new `GroupProcessingQueue` class provides per-group FIFO queues with TTL safety valves. The polling loop in `index.ts` is refactored to store messages immediately and enqueue mentions, rather than blocking on `handleMessageBatch`. `MessageHandler` is simplified to expose just the LLM processing path. A new `MessageIngestion` module extracts the message filtering/storage/mention-detection pipeline from `handleMessageBatch`.

**Tech Stack:** TypeScript, Vitest, Node.js async patterns (no new dependencies)

**Spec:** `docs/superpowers/specs/2026-03-18-per-group-processing-queue-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `bot/src/groupProcessingQueue.ts` | Create | Per-group FIFO queue with TTL, cap, shutdown |
| `bot/tests/groupProcessingQueue.test.ts` | Create | Unit tests for queue |
| `bot/src/messageIngestion.ts` | Create | Extract message filtering, storage, mention detection, coalescing |
| `bot/tests/messageIngestion.test.ts` | Create | Unit tests for ingestion pipeline |
| `bot/src/messageHandler.ts` | Modify | Remove `handleMessage`/`handleMessageBatch`, expose `processLlmRequest` |
| `bot/tests/messageHandler.test.ts` | Modify | Update tests for simplified interface |
| `bot/src/index.ts` | Modify | Wire queue + ingestion into polling loop |
| `bot/src/types.ts` | Modify | Add `MentionRequest`, `QueueItem` types |

---

### Task 1: Add Types

**Files:**
- Modify: `bot/src/types.ts`

- [ ] **Step 1: Add MentionRequest and QueueItem types**

Add at the end of `bot/src/types.ts`:

```typescript
/** A single mention to process via the group processing queue */
export interface MentionRequest {
  groupId: string;
  sender: string;
  content: string;
  attachments: SignalAttachment[];
  timestamp: number;
}

/** A queue item — either a single mention or a coalesced batch of missed mentions */
export type QueueItem =
  | { kind: 'single'; request: MentionRequest }
  | { kind: 'coalesced'; requests: MentionRequest[]; missedFraming: string };
```

- [ ] **Step 2: Verify it compiles**

Run: `cd bot && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add bot/src/types.ts
git commit -m "feat: add MentionRequest and QueueItem types for per-group queue"
```

---

### Task 2: GroupProcessingQueue — Core Queue Logic

**Files:**
- Create: `bot/src/groupProcessingQueue.ts`
- Create: `bot/tests/groupProcessingQueue.test.ts`

- [ ] **Step 1: Write failing test for basic enqueue/process**

Create `bot/tests/groupProcessingQueue.test.ts`:

```typescript
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

    // Wait for async worker to drain
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd bot && npx vitest run tests/groupProcessingQueue.test.ts`
Expected: FAIL — module `groupProcessingQueue` not found

- [ ] **Step 3: Write minimal GroupProcessingQueue implementation**

Create `bot/src/groupProcessingQueue.ts`:

```typescript
import { logger } from './logger';
import type { QueueItem } from './types';

interface GroupState {
  queue: QueueItem[];
  processing: boolean;
}

export class GroupProcessingQueue {
  private groups = new Map<string, GroupState>();
  private processCallback: (item: QueueItem) => Promise<void>;
  private stopped = false;

  constructor(processCallback: (item: QueueItem) => Promise<void>) {
    this.processCallback = processCallback;
  }

  enqueue(item: QueueItem): void {
    if (this.stopped) return;

    const groupId = item.kind === 'single' ? item.request.groupId : item.requests[0].groupId;
    let state = this.groups.get(groupId);
    if (!state) {
      state = { queue: [], processing: false };
      this.groups.set(groupId, state);
    }

    state.queue.push(item);
    logger.info(`Queue enqueue [${groupId}]: depth=${state.queue.length}`);

    if (!state.processing) {
      this.startWorker(groupId, state);
    }
  }

  isProcessing(groupId: string): boolean {
    return this.groups.get(groupId)?.processing ?? false;
  }

  getPendingCount(groupId: string): number {
    return this.groups.get(groupId)?.queue.length ?? 0;
  }

  shutdown(): void {
    this.stopped = true;
    for (const [groupId, state] of this.groups) {
      if (state.queue.length > 0) {
        logger.warn(`Queue shutdown: discarding ${state.queue.length} pending item(s) for group ${groupId}`);
        state.queue = [];
      }
    }
  }

  private startWorker(groupId: string, state: GroupState): void {
    state.processing = true;

    const run = async () => {
      while (state.queue.length > 0 && !this.stopped) {
        const item = state.queue.shift()!;
        const start = Date.now();
        logger.info(`Queue worker start [${groupId}]`);

        try {
          await this.processCallback(item);
        } catch (error) {
          logger.error(`Queue worker error [${groupId}]:`, error);
        }

        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        logger.info(`Queue worker complete [${groupId}]: ${elapsed}s`);
      }
      state.processing = false;
    };

    // Fire and forget — the worker runs asynchronously
    run().catch(error => {
      logger.error(`Queue worker fatal [${groupId}]:`, error);
      state.processing = false;
    });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd bot && npx vitest run tests/groupProcessingQueue.test.ts`
Expected: 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add bot/src/groupProcessingQueue.ts bot/tests/groupProcessingQueue.test.ts
git commit -m "feat: add GroupProcessingQueue with core enqueue/process logic"
```

---

### Task 3: GroupProcessingQueue — Per-Group Isolation

**Files:**
- Modify: `bot/tests/groupProcessingQueue.test.ts`

- [ ] **Step 1: Write failing test for cross-group concurrency**

Add to the `describe('GroupProcessingQueue')` block:

```typescript
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

    // Both should start before either ends (concurrent)
    const startG1 = order.indexOf('start:g1');
    const startG2 = order.indexOf('start:g2');
    const endG1 = order.indexOf('end:g1');
    const endG2 = order.indexOf('end:g2');
    expect(startG1).toBeLessThan(endG1);
    expect(startG2).toBeLessThan(endG2);
    // Both start before either finishes
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
    // Allow microtask for worker to start
    await new Promise(r => setTimeout(r, 0));

    expect(queue.isProcessing('g1')).toBe(true);
    expect(queue.isProcessing('g2')).toBe(false);
    expect(queue.getPendingCount('g1')).toBe(0); // item was shifted off, in-flight

    resolveProcessing!();
    await vi.waitFor(() => {
      expect(queue.isProcessing('g1')).toBe(false);
    });
  });
```

- [ ] **Step 2: Run tests to verify they pass**

These should pass with the existing implementation since per-group isolation is inherent in the design.

Run: `cd bot && npx vitest run tests/groupProcessingQueue.test.ts`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add bot/tests/groupProcessingQueue.test.ts
git commit -m "test: add per-group isolation and state reporting tests"
```

---

### Task 4: GroupProcessingQueue — TTL Safety Valve

**Files:**
- Modify: `bot/src/groupProcessingQueue.ts`
- Modify: `bot/tests/groupProcessingQueue.test.ts`

- [ ] **Step 1: Write failing test for TTL expiry**

Add to the test file:

```typescript
  describe('TTL safety valve', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should release lock and move to next item when TTL expires', async () => {
      const results: string[] = [];
      let hangForever: Promise<void>;

      const callback = async (item: QueueItem) => {
        const content = item.kind === 'single' ? item.request.content : 'coalesced';
        if (content === 'hang') {
          hangForever = new Promise(() => {}); // never resolves
          await hangForever;
        }
        results.push(content);
      };
      queue = new GroupProcessingQueue(callback, { ttlMs: 1000 });

      queue.enqueue(singleItem('g1', { content: 'hang' }));
      queue.enqueue(singleItem('g1', { content: 'second' }));

      // Let worker start
      await vi.advanceTimersByTimeAsync(0);

      // TTL fires
      await vi.advanceTimersByTimeAsync(1000);

      // Worker processes next item
      await vi.advanceTimersByTimeAsync(0);

      expect(results).toContain('second');
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd bot && npx vitest run tests/groupProcessingQueue.test.ts`
Expected: FAIL — constructor doesn't accept options

- [ ] **Step 3: Add TTL support to GroupProcessingQueue**

Update `bot/src/groupProcessingQueue.ts`. Modify the constructor and worker loop:

```typescript
import { logger } from './logger';
import type { QueueItem } from './types';

const DEFAULT_TTL_MS = 6 * 60 * 1000; // 6 minutes
const DEFAULT_MAX_QUEUE_SIZE = 10;

interface GroupState {
  queue: QueueItem[];
  processing: boolean;
  lockTimeout: ReturnType<typeof setTimeout> | null;
}

export interface GroupProcessingQueueOptions {
  ttlMs?: number;
  maxQueueSize?: number;
}

export class GroupProcessingQueue {
  private groups = new Map<string, GroupState>();
  private processCallback: (item: QueueItem) => Promise<void>;
  private stopped = false;
  private readonly ttlMs: number;
  private readonly maxQueueSize: number;

  constructor(
    processCallback: (item: QueueItem) => Promise<void>,
    options?: GroupProcessingQueueOptions,
  ) {
    this.processCallback = processCallback;
    this.ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
    this.maxQueueSize = options?.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
  }

  enqueue(item: QueueItem): void {
    if (this.stopped) return;

    const groupId = item.kind === 'single' ? item.request.groupId : item.requests[0].groupId;
    let state = this.groups.get(groupId);
    if (!state) {
      state = { queue: [], processing: false, lockTimeout: null };
      this.groups.set(groupId, state);
    }

    if (state.queue.length >= this.maxQueueSize) {
      logger.warn(`Queue cap reached [${groupId}]: dropping mention (max=${this.maxQueueSize})`);
      return;
    }

    state.queue.push(item);
    logger.info(`Queue enqueue [${groupId}]: depth=${state.queue.length}`);

    if (!state.processing) {
      this.startWorker(groupId, state);
    }
  }

  isProcessing(groupId: string): boolean {
    return this.groups.get(groupId)?.processing ?? false;
  }

  getPendingCount(groupId: string): number {
    return this.groups.get(groupId)?.queue.length ?? 0;
  }

  shutdown(): void {
    this.stopped = true;
    for (const [groupId, state] of this.groups) {
      if (state.lockTimeout) {
        clearTimeout(state.lockTimeout);
        state.lockTimeout = null;
      }
      if (state.queue.length > 0) {
        logger.warn(`Queue shutdown: discarding ${state.queue.length} pending item(s) for group ${groupId}`);
        state.queue = [];
      }
    }
  }

  private startWorker(groupId: string, state: GroupState): void {
    state.processing = true;

    const run = async () => {
      while (state.queue.length > 0 && !this.stopped) {
        const item = state.queue.shift()!;
        const start = Date.now();
        logger.info(`Queue worker start [${groupId}]`);

        // Note: If TTL fires, Promise.race resolves but the hung callback
        // keeps running in the background, holding its SpawnLimiter slot.
        // This is an accepted limitation — the hung Claude process will be
        // killed by the CLI's own 5-minute timeout, then SpawnLimiter releases
        // the slot. During the overlap window, the next item may block on
        // SpawnLimiter.acquire() until the slot frees up.
        try {
          await Promise.race([
            this.processCallback(item),
            this.ttlPromise(state),
          ]);
        } catch (error) {
          logger.error(`Queue worker error [${groupId}]:`, error);
        } finally {
          if (state.lockTimeout) {
            clearTimeout(state.lockTimeout);
            state.lockTimeout = null;
          }
        }

        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        logger.info(`Queue worker complete [${groupId}]: ${elapsed}s`);
      }
      state.processing = false;
    };

    run().catch(error => {
      logger.error(`Queue worker fatal [${groupId}]:`, error);
      state.processing = false;
    });
  }

  private ttlPromise(state: GroupState): Promise<void> {
    return new Promise<void>((resolve) => {
      state.lockTimeout = setTimeout(() => {
        logger.warn(`Queue TTL expired — releasing lock (ttl=${this.ttlMs}ms)`);
        resolve();
      }, this.ttlMs);
    });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd bot && npx vitest run tests/groupProcessingQueue.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add bot/src/groupProcessingQueue.ts bot/tests/groupProcessingQueue.test.ts
git commit -m "feat: add TTL safety valve and queue cap to GroupProcessingQueue"
```

---

### Task 5: GroupProcessingQueue — Queue Cap and Shutdown

**Files:**
- Modify: `bot/tests/groupProcessingQueue.test.ts`

- [ ] **Step 1: Write tests for queue cap and shutdown**

Add to the test file:

```typescript
  describe('queue cap', () => {
    it('should drop new items when queue is full', () => {
      const callback = async () => {
        await new Promise(() => {}); // block forever
      };
      queue = new GroupProcessingQueue(callback, { maxQueueSize: 2 });

      // First enqueue starts processing, so it's not in the queue
      queue.enqueue(singleItem('g1', { content: 'processing' }));
      // These go into the queue
      queue.enqueue(singleItem('g1', { content: 'queued1' }));
      queue.enqueue(singleItem('g1', { content: 'queued2' }));
      // This should be dropped
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

      // Allow worker to start
      await new Promise(r => setTimeout(r, 0));

      expect(queue.getPendingCount('g1')).toBe(1);

      queue.shutdown();
      expect(queue.getPendingCount('g1')).toBe(0);
    });
  });
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd bot && npx vitest run tests/groupProcessingQueue.test.ts`
Expected: All tests PASS (implementation already handles cap and shutdown)

- [ ] **Step 3: Commit**

```bash
git add bot/tests/groupProcessingQueue.test.ts
git commit -m "test: add queue cap and shutdown tests for GroupProcessingQueue"
```

---

### Task 6: MessageIngestion — Extract Ingestion Pipeline

**Files:**
- Create: `bot/src/messageIngestion.ts`
- Create: `bot/tests/messageIngestion.test.ts`

This extracts the message filtering, storage, mention detection, attachment ingestion, and coalescing logic from `handleMessageBatch` into a standalone function. The polling loop will call this instead of `handleMessageBatch`.

- [ ] **Step 1: Write failing test for ingestMessages**

Create `bot/tests/messageIngestion.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ingestMessages } from '../src/messageIngestion';
import type { SignalClient } from '../src/signalClient';
import type { Storage } from '../src/storage';
import type { ExtractedMessage, QueueItem } from '../src/types';

vi.mock('../src/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    compact: vi.fn(),
  },
}));

describe('ingestMessages', () => {
  let mockStorage: Storage;
  let mockSignal: SignalClient;
  let enqueuedItems: QueueItem[];

  beforeEach(() => {
    vi.clearAllMocks();
    enqueuedItems = [];

    mockStorage = {
      addMessage: vi.fn(),
      saveAttachment: vi.fn(),
      groupSettings: {
        isEnabled: vi.fn().mockReturnValue(true),
        getTriggers: vi.fn().mockReturnValue(null),
        getToolNotifications: vi.fn().mockReturnValue(false),
      },
    } as any;

    mockSignal = {
      readAttachmentFile: vi.fn().mockReturnValue(null),
    } as any;
  });

  function makeMsg(overrides?: Partial<ExtractedMessage>): ExtractedMessage {
    return {
      sender: '+61400111222',
      content: 'hello',
      groupId: 'g1',
      timestamp: Date.now(),
      attachments: [],
      ...overrides,
    };
  }

  it('should store all messages', () => {
    const messages = [makeMsg({ content: 'hey' }), makeMsg({ content: 'hi' })];
    ingestMessages({
      messages,
      mentionTriggers: ['@bot'],
      botPhoneNumber: '+61000',
      storage: mockStorage,
      signalClient: mockSignal,
      enqueue: (item) => enqueuedItems.push(item),
    });

    expect(mockStorage.addMessage).toHaveBeenCalledTimes(2);
  });

  it('should skip bot-self messages', () => {
    const messages = [makeMsg({ sender: '+61000', content: '@bot hello' })];
    ingestMessages({
      messages,
      mentionTriggers: ['@bot'],
      botPhoneNumber: '+61000',
      storage: mockStorage,
      signalClient: mockSignal,
      enqueue: (item) => enqueuedItems.push(item),
    });

    expect(mockStorage.addMessage).not.toHaveBeenCalled();
    expect(enqueuedItems).toHaveLength(0);
  });

  it('should enqueue mentions as single QueueItems', () => {
    const messages = [makeMsg({ content: '@bot hello', timestamp: Date.now() })];
    ingestMessages({
      messages,
      mentionTriggers: ['@bot'],
      botPhoneNumber: '+61000',
      storage: mockStorage,
      signalClient: mockSignal,
      enqueue: (item) => enqueuedItems.push(item),
    });

    expect(enqueuedItems).toHaveLength(1);
    expect(enqueuedItems[0].kind).toBe('single');
  });

  it('should not enqueue non-mention messages', () => {
    const messages = [makeMsg({ content: 'just chatting' })];
    ingestMessages({
      messages,
      mentionTriggers: ['@bot'],
      botPhoneNumber: '+61000',
      storage: mockStorage,
      signalClient: mockSignal,
      enqueue: (item) => enqueuedItems.push(item),
    });

    expect(enqueuedItems).toHaveLength(0);
  });

  it('should not enqueue for disabled groups', () => {
    (mockStorage.groupSettings.isEnabled as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const messages = [makeMsg({ content: '@bot hello' })];
    ingestMessages({
      messages,
      mentionTriggers: ['@bot'],
      botPhoneNumber: '+61000',
      storage: mockStorage,
      signalClient: mockSignal,
      enqueue: (item) => enqueuedItems.push(item),
    });

    expect(mockStorage.addMessage).toHaveBeenCalledTimes(1); // still stored
    expect(enqueuedItems).toHaveLength(0); // but not enqueued
  });

  it('should not enqueue for storeOnly groups', () => {
    const messages = [makeMsg({ content: '@bot hello' })];
    ingestMessages({
      messages,
      mentionTriggers: ['@bot'],
      botPhoneNumber: '+61000',
      storage: mockStorage,
      signalClient: mockSignal,
      enqueue: (item) => enqueuedItems.push(item),
      storeOnlyGroupIds: new Set(['g1']),
    });

    expect(mockStorage.addMessage).toHaveBeenCalledTimes(1);
    expect(enqueuedItems).toHaveLength(0);
  });

  it('should use per-group custom triggers when available', () => {
    (mockStorage.groupSettings.getTriggers as ReturnType<typeof vi.fn>).mockReturnValue(['hey bot']);
    const messages = [makeMsg({ content: 'hey bot do stuff' })];
    ingestMessages({
      messages,
      mentionTriggers: ['@bot'],
      botPhoneNumber: '+61000',
      storage: mockStorage,
      signalClient: mockSignal,
      enqueue: (item) => enqueuedItems.push(item),
    });

    expect(enqueuedItems).toHaveLength(1);
  });

  it('should coalesce multiple missed mentions into a single queue item', () => {
    const now = Date.now();
    const messages = [
      makeMsg({ content: '@bot first', timestamp: now - 60000, sender: 'Alice' }),
      makeMsg({ content: '@bot second', timestamp: now - 30000, sender: 'Bob' }),
    ];
    ingestMessages({
      messages,
      mentionTriggers: ['@bot'],
      botPhoneNumber: '+61000',
      storage: mockStorage,
      signalClient: mockSignal,
      enqueue: (item) => enqueuedItems.push(item),
      realtimeThresholdMs: 5000,
    });

    expect(enqueuedItems).toHaveLength(1);
    expect(enqueuedItems[0].kind).toBe('coalesced');
    if (enqueuedItems[0].kind === 'coalesced') {
      expect(enqueuedItems[0].requests).toHaveLength(2);
      expect(enqueuedItems[0].missedFraming).toContain('missed');
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd bot && npx vitest run tests/messageIngestion.test.ts`
Expected: FAIL — module `messageIngestion` not found

- [ ] **Step 3: Write the ingestMessages function**

Create `bot/src/messageIngestion.ts`:

```typescript
import { logger } from './logger';
import { MentionDetector } from './mentionDetector';
import { MessageDeduplicator } from './messageDeduplicator';
import type { SignalClient } from './signalClient';
import type { Storage } from './storage';
import type { ExtractedMessage, MentionRequest, QueueItem } from './types';

export const REALTIME_THRESHOLD_MS = 5000;

export interface IngestOptions {
  messages: ExtractedMessage[];
  mentionTriggers: string[];
  botPhoneNumber: string;
  storage: Storage;
  signalClient: SignalClient;
  enqueue: (item: QueueItem) => void;
  storeOnlyGroupIds?: Set<string>;
  realtimeThresholdMs?: number;
  deduplicator?: MessageDeduplicator;
  attachmentsDir?: string;
}

export function ingestMessages(options: IngestOptions): void {
  const {
    messages,
    mentionTriggers,
    botPhoneNumber,
    storage,
    signalClient,
    enqueue,
    storeOnlyGroupIds,
    attachmentsDir,
  } = options;
  const realtimeThresholdMs = options.realtimeThresholdMs ?? REALTIME_THRESHOLD_MS;
  const deduplicator = options.deduplicator;
  const defaultDetector = new MentionDetector(mentionTriggers);

  // Group messages by groupId for batch processing
  const byGroup = new Map<string, ExtractedMessage[]>();
  for (const msg of messages) {
    // Filter bot-self
    if (botPhoneNumber && msg.sender === botPhoneNumber) continue;
    // Dedup
    if (deduplicator?.isDuplicate(msg.groupId, msg.sender, msg.timestamp)) continue;

    if (!byGroup.has(msg.groupId)) byGroup.set(msg.groupId, []);
    byGroup.get(msg.groupId)!.push(msg);
  }

  const now = Date.now();

  for (const [groupId, groupMessages] of byGroup) {
    const isStoreOnly = storeOnlyGroupIds?.has(groupId) ?? false;
    const isEnabled = storage.groupSettings.isEnabled(groupId);

    // Store all messages
    for (const msg of groupMessages) {
      storage.addMessage({
        groupId: msg.groupId,
        sender: msg.sender,
        content: msg.content,
        timestamp: msg.timestamp,
        isBot: false,
        attachments: msg.attachments.length > 0 ? msg.attachments : undefined,
      });
    }

    // Ingest image attachments (skip for storeOnly and disabled groups)
    if (!isStoreOnly && isEnabled && attachmentsDir) {
      for (const msg of groupMessages) {
        for (const att of msg.attachments) {
          if (att.contentType.startsWith('image/')) {
            const file = signalClient.readAttachmentFile(attachmentsDir, att.id);
            if (file) {
              storage.saveAttachment({
                id: att.id,
                groupId,
                sender: msg.sender,
                contentType: att.contentType,
                size: att.size,
                filename: att.filename,
                data: file.data,
                timestamp: msg.timestamp,
              });
            }
          }
        }
      }
    }

    // Don't enqueue for storeOnly or disabled groups
    if (isStoreOnly || !isEnabled) continue;

    // Detect mentions using per-group triggers or defaults
    const customTriggers = storage.groupSettings.getTriggers(groupId);
    const detector = customTriggers ? new MentionDetector(customTriggers) : defaultDetector;

    const mentionMessages = groupMessages.filter(msg => detector.isMentioned(msg.content));
    if (mentionMessages.length === 0) continue;

    // Classify missed vs realtime
    const missed = mentionMessages.filter(m => now - m.timestamp > realtimeThresholdMs);
    const realtime = mentionMessages.filter(m => now - m.timestamp <= realtimeThresholdMs);

    // Coalesce missed mentions
    if (missed.length > 1) {
      const missedFraming = buildMissedFraming(missed, now);
      const requests: MentionRequest[] = missed.map(m => ({
        groupId: m.groupId,
        sender: m.sender,
        content: m.content,
        attachments: m.attachments,
        timestamp: m.timestamp,
      }));
      enqueue({ kind: 'coalesced', requests, missedFraming });
      logger.debug(`Coalesced ${missed.length} missed mentions for group ${groupId}`);
    } else if (missed.length === 1) {
      enqueue({ kind: 'single', request: toMentionRequest(missed[0]) });
    }

    // Enqueue realtime mentions individually
    for (const msg of realtime) {
      enqueue({ kind: 'single', request: toMentionRequest(msg) });
    }
  }
}

function toMentionRequest(msg: ExtractedMessage): MentionRequest {
  return {
    groupId: msg.groupId,
    sender: msg.sender,
    content: msg.content,
    attachments: msg.attachments,
    timestamp: msg.timestamp,
  };
}

function buildMissedFraming(missed: ExtractedMessage[], now: number): string {
  const lines = missed.map(m => {
    const agoSeconds = Math.round((now - m.timestamp) / 1000);
    let agoStr: string;
    if (agoSeconds < 60) {
      agoStr = `${agoSeconds}s ago`;
    } else if (agoSeconds < 3600) {
      agoStr = `${Math.round(agoSeconds / 60)} min ago`;
    } else {
      agoStr = `${Math.round(agoSeconds / 3600)}h ago`;
    }
    return `- [${m.sender}] (${agoStr}): "${m.content}"`;
  });
  return `You were offline and missed the following messages:\n${lines.join('\n')}\n\nRespond to all of these in a single message.`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd bot && npx vitest run tests/messageIngestion.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add bot/src/messageIngestion.ts bot/tests/messageIngestion.test.ts
git commit -m "feat: extract message ingestion pipeline from MessageHandler"
```

---

### Task 7: Simplify MessageHandler

**Files:**
- Modify: `bot/src/messageHandler.ts`
- Modify: `bot/tests/messageHandler.test.ts`

Remove `handleMessage`, `handleMessageBatch`, `buildMissedMessageFraming`, and the deduplicator/mentionDetector dependencies. Expose `processLlmRequest` via a public `processRequest` method. Keep `runMaintenance` and `assembleAdditionalContext` unchanged.

- [ ] **Step 1: Write test for the new processRequest method**

Replace the contents of `bot/tests/messageHandler.test.ts`. The old tests for `handleMessage`/`handleMessageBatch` are no longer needed — those responsibilities moved to `messageIngestion.ts`. The new tests cover `processRequest` and `runMaintenance`.

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageHandler } from '../src/messageHandler';
import type { SignalClient } from '../src/signalClient';
import type { Storage } from '../src/storage';
import type { AppConfig, LLMClient, MentionRequest, Message } from '../src/types';

vi.mock('../src/logger', () => ({
  logger: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    group: vi.fn(),
    step: vi.fn(),
    groupEnd: vi.fn(),
    compact: vi.fn(),
  },
}));

function makeAppConfig(overrides?: Partial<AppConfig>): AppConfig {
  return {
    dbPath: './data/bot.db',
    timezone: 'Australia/Sydney',
    githubRepo: '',
    sourceRoot: '',
    signalCliUrl: '',
    botPhoneNumber: '+1234567890',
    attachmentsDir: './data/signal-attachments',
    whisperModelPath: './models/ggml-base.en.bin',
    darkFactoryEnabled: '',
    darkFactoryProjectRoot: '',
    ...overrides,
  };
}

describe('MessageHandler', () => {
  let mockStorage: Storage;
  let mockLLM: LLMClient;
  let mockSignal: SignalClient;

  beforeEach(() => {
    vi.clearAllMocks();

    mockStorage = {
      addMessage: vi.fn(),
      getRecentMessages: vi.fn().mockReturnValue([]),
      trimMessages: vi.fn(),
      trimAttachments: vi.fn(),
      getDossiersByGroup: vi.fn().mockReturnValue([]),
      getMemoriesByGroup: vi.fn().mockReturnValue([]),
      getActivePersonaForGroup: vi.fn().mockReturnValue(null),
      getDistinctGroupIds: vi.fn().mockReturnValue(['g1']),
      saveAttachment: vi.fn(),
      groupSettings: {
        getToolNotifications: vi.fn().mockReturnValue(false),
        isEnabled: vi.fn().mockReturnValue(true),
        getTriggers: vi.fn().mockReturnValue(null),
      },
    } as any;

    mockLLM = {
      generateResponse: vi.fn().mockResolvedValue({
        content: 'Test response',
        tokensUsed: 25,
        sentViaMcp: false,
        mcpMessages: [],
      }),
    };

    mockSignal = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendTyping: vi.fn().mockResolvedValue(undefined),
      stopTyping: vi.fn().mockResolvedValue(undefined),
      readAttachmentFile: vi.fn().mockReturnValue(null),
    } as any;
  });

  describe('processRequest', () => {
    it('should fetch fresh history and invoke the LLM', async () => {
      const handler = new MessageHandler({
        storage: mockStorage,
        llmClient: mockLLM,
        signalClient: mockSignal,
        appConfig: makeAppConfig(),
      });

      const request: MentionRequest = {
        groupId: 'g1',
        sender: 'Alice',
        content: '@bot hello',
        attachments: [],
        timestamp: 1000,
      };

      await handler.processRequest({ kind: 'single', request });

      expect(mockStorage.getRecentMessages).toHaveBeenCalledWith('g1', expect.any(Number));
      expect(mockLLM.generateResponse).toHaveBeenCalled();
    });

    it('should filter the triggering message from history', async () => {
      const triggerTimestamp = 5000;
      const historyMessages: Message[] = [
        { id: 1, groupId: 'g1', sender: 'Bob', content: 'hey', timestamp: 4000, isBot: false },
        { id: 2, groupId: 'g1', sender: 'Alice', content: '@bot hello', timestamp: triggerTimestamp, isBot: false },
        { id: 3, groupId: 'g1', sender: 'Charlie', content: 'sup', timestamp: 6000, isBot: false },
      ];
      (mockStorage.getRecentMessages as ReturnType<typeof vi.fn>).mockReturnValue(historyMessages);

      const handler = new MessageHandler({
        storage: mockStorage,
        llmClient: mockLLM,
        signalClient: mockSignal,
        appConfig: makeAppConfig(),
      });

      const request: MentionRequest = {
        groupId: 'g1',
        sender: 'Alice',
        content: '@bot hello',
        attachments: [],
        timestamp: triggerTimestamp,
      };

      await handler.processRequest({ kind: 'single', request });

      // The LLM should receive context that does NOT include the trigger message
      // but DOES include other messages (even those after the trigger)
      const llmCall = (mockLLM.generateResponse as ReturnType<typeof vi.fn>).mock.calls[0];
      const contextStr = JSON.stringify(llmCall[0]);
      expect(contextStr).toContain('hey'); // Bob's message
      expect(contextStr).toContain('sup'); // Charlie's message (after trigger, different sender)
    });

    it('should send response to the group', async () => {
      const handler = new MessageHandler({
        storage: mockStorage,
        llmClient: mockLLM,
        signalClient: mockSignal,
        appConfig: makeAppConfig(),
      });

      const request: MentionRequest = {
        groupId: 'g1',
        sender: 'Alice',
        content: '@bot hello',
        attachments: [],
        timestamp: 1000,
      };

      await handler.processRequest({ kind: 'single', request });

      expect(mockSignal.sendMessage).toHaveBeenCalledWith('g1', 'Test response');
    });

    it('should store bot response', async () => {
      const handler = new MessageHandler({
        storage: mockStorage,
        llmClient: mockLLM,
        signalClient: mockSignal,
        appConfig: makeAppConfig(),
      });

      const request: MentionRequest = {
        groupId: 'g1',
        sender: 'Alice',
        content: '@bot hello',
        attachments: [],
        timestamp: 1000,
      };

      await handler.processRequest({ kind: 'single', request });

      expect(mockStorage.addMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          groupId: 'g1',
          content: 'Test response',
          isBot: true,
        }),
      );
    });

    it('should handle coalesced items with missed framing', async () => {
      const handler = new MessageHandler({
        storage: mockStorage,
        llmClient: mockLLM,
        signalClient: mockSignal,
        appConfig: makeAppConfig(),
      });

      await handler.processRequest({
        kind: 'coalesced',
        requests: [
          { groupId: 'g1', sender: 'Alice', content: '@bot first', attachments: [], timestamp: 1000 },
          { groupId: 'g1', sender: 'Bob', content: '@bot second', attachments: [], timestamp: 2000 },
        ],
        missedFraming: 'You were offline and missed these messages',
      });

      expect(mockLLM.generateResponse).toHaveBeenCalled();
      const prompt = (mockLLM.generateResponse as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const promptStr = JSON.stringify(prompt);
      expect(promptStr).toContain('missed');
    });

    it('should send error message to group on LLM failure', async () => {
      (mockLLM.generateResponse as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('LLM failed'));

      const handler = new MessageHandler({
        storage: mockStorage,
        llmClient: mockLLM,
        signalClient: mockSignal,
        appConfig: makeAppConfig(),
      });

      const request: MentionRequest = {
        groupId: 'g1',
        sender: 'Alice',
        content: '@bot hello',
        attachments: [],
        timestamp: 1000,
      };

      await handler.processRequest({ kind: 'single', request });

      expect(mockSignal.sendMessage).toHaveBeenCalledWith('g1', expect.stringContaining('error'));
    });
  });

  describe('runMaintenance', () => {
    it('should trim messages for all groups', () => {
      (mockStorage.getDistinctGroupIds as ReturnType<typeof vi.fn>).mockReturnValue(['g1', 'g2']);

      const handler = new MessageHandler({
        storage: mockStorage,
        llmClient: mockLLM,
        signalClient: mockSignal,
        appConfig: makeAppConfig(),
      });

      handler.runMaintenance();

      expect(mockStorage.trimMessages).toHaveBeenCalledTimes(2);
      expect(mockStorage.trimAttachments).toHaveBeenCalledTimes(1);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd bot && npx vitest run tests/messageHandler.test.ts`
Expected: FAIL — `processRequest` does not exist

- [ ] **Step 3: Refactor MessageHandler**

Rewrite `bot/src/messageHandler.ts`:

```typescript
import { ContextBuilder } from './contextBuilder';
import { logger } from './logger';
import { estimateTokens } from './mcp/result';
import { MentionDetector } from './mentionDetector';
import type { SignalClient } from './signalClient';
import type { Storage } from './storage';
import type { AppConfig, LLMClient, MentionRequest, Message, QueueItem, SignalAttachment } from './types';

export interface MessageHandlerOptions {
  systemPrompt?: string;
  contextWindowSize?: number;
  contextTokenBudget?: number;
  messageRetentionCount?: number;
  attachmentRetentionDays?: number;
  collaborativeTestingMode?: boolean;
  mentionTriggers?: string[];
}

export class MessageHandler {
  private contextBuilder: ContextBuilder;
  private mentionDetector: MentionDetector;
  private appConfig: AppConfig;
  private storage: Storage;
  private llmClient: LLMClient;
  private signalClient: SignalClient;
  private contextWindowSize: number;
  private messageRetentionCount: number;
  private readonly attachmentRetentionDays: number;

  constructor(
    deps: {
      storage: Storage;
      llmClient: LLMClient;
      signalClient: SignalClient;
      appConfig?: AppConfig;
    },
    options?: MessageHandlerOptions,
  ) {
    this.appConfig = deps.appConfig || {
      dbPath: './data/bot.db',
      timezone: 'Australia/Sydney',
      githubRepo: '',
      sourceRoot: '',
      signalCliUrl: '',
      botPhoneNumber: '',
      attachmentsDir: './data/signal-attachments',
      whisperModelPath: './models/ggml-base.en.bin',
      darkFactoryEnabled: '',
      darkFactoryProjectRoot: '',
    };
    this.storage = deps.storage;
    this.llmClient = deps.llmClient;
    this.signalClient = deps.signalClient;
    this.contextWindowSize = options?.contextWindowSize || 200;
    this.messageRetentionCount = options?.messageRetentionCount || 1000;
    this.attachmentRetentionDays = options?.attachmentRetentionDays || 30;

    this.mentionDetector = new MentionDetector(options?.mentionTriggers || ['@bot']);
    this.contextBuilder = new ContextBuilder({
      systemPrompt: options?.systemPrompt || '',
      timezone: this.appConfig.timezone,
      contextTokenBudget: options?.contextTokenBudget || 4000,
      attachmentsDir: this.appConfig.attachmentsDir,
      collaborativeTestingMode: options?.collaborativeTestingMode,
    });
  }

  runMaintenance(): void {
    const groupIds = this.storage.getDistinctGroupIds();
    for (const groupId of groupIds) {
      try {
        this.storage.trimMessages(groupId, this.messageRetentionCount);
      } catch (error) {
        logger.error(`Failed to trim messages for group ${groupId}:`, error);
      }
    }
    try {
      const cutoff = Date.now() - this.attachmentRetentionDays * 24 * 60 * 60 * 1000;
      this.storage.trimAttachments(cutoff);
    } catch (error) {
      logger.error('Failed to trim attachments:', error);
    }
  }

  async processRequest(item: QueueItem): Promise<void> {
    const { groupId, sender, content, attachments, timestamp } =
      item.kind === 'single' ? item.request : item.requests[item.requests.length - 1];
    const missedFraming = item.kind === 'coalesced' ? item.missedFraming : undefined;

    logger.group('MESSAGE RECEIVED');
    logger.step(`group: ${groupId}  sender: ${sender}`);
    logger.step(`content: "${content.substring(0, 100)}"`);

    try {
      // Fetch fresh history, filtering out the triggering message
      const allHistory = this.storage.getRecentMessages(groupId, this.contextWindowSize);
      const history = this.filterTriggerMessage(allHistory, item);
      const fitted = this.contextBuilder.fitToTokenBudget(history);

      logger.step(`history: ${fitted.messages.length} messages fetched`);

      // Extract query
      const query = this.mentionDetector.extractQuery(content);

      // Append attachment info to query
      const voiceLines = attachments
        .filter(a => a.contentType.startsWith('audio/'))
        .map(a => this.contextBuilder.formatVoiceAttachment(a.id));
      const imageLines = attachments
        .filter(a => a.contentType.startsWith('image/'))
        .map(a => this.contextBuilder.formatImageAttachment(a.id));
      const allAttachmentLines = [...voiceLines, ...imageLines];

      let queryWithAttachments = query;
      if (allAttachmentLines.length > 0) {
        const attachmentBlock = allAttachmentLines.join('\n');
        queryWithAttachments = query ? `${query}\n\n${attachmentBlock}` : attachmentBlock;
      }

      if (missedFraming) {
        queryWithAttachments = missedFraming + (queryWithAttachments ? `\n\n${queryWithAttachments}` : '');
      }

      // Build additional context
      const { additionalContext, nameMap, personaPrompt } = this.assembleAdditionalContext(groupId);

      const messages = this.contextBuilder.buildContext({
        history: fitted.messages,
        query: queryWithAttachments,
        groupId,
        sender,
        dossierContext: additionalContext,
        personaDescription: personaPrompt,
        nameMap,
        preFormatted: fitted.formatted,
      });

      logger.step(`context: ${nameMap.size} dossiers${personaPrompt ? ', with persona' : ''}`);

      // Get LLM response
      const startTime = Date.now();
      const toolNotificationsEnabled = this.storage.groupSettings.getToolNotifications(groupId);
      const response = await this.llmClient.generateResponse(messages, {
        ...this.appConfig,
        groupId,
        sender,
        toolNotificationsEnabled,
      });

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      logger.step(`llm: response in ${elapsed}s (${response.tokensUsed} tokens)`);

      const botSender = this.appConfig.botPhoneNumber || 'bot';
      if (response.sentViaMcp) {
        for (const mcpMsg of response.mcpMessages) {
          this.storage.addMessage({
            groupId,
            sender: botSender,
            content: mcpMsg,
            timestamp: Date.now(),
            isBot: true,
          });
        }
        logger.step(`delivery: sent via MCP (${response.mcpMessages.length} message(s))`);
      } else {
        await this.signalClient.sendMessage(groupId, response.content);
        this.storage.addMessage({
          groupId,
          sender: botSender,
          content: response.content,
          timestamp: Date.now(),
          isBot: true,
        });
        logger.step('delivery: sent via fallback');
      }

      logger.groupEnd();
    } catch (error) {
      logger.error('Error handling message:', error);
      logger.groupEnd();
      try {
        const errorMsg = 'Sorry, I encountered an error processing your request.';
        await this.signalClient.sendMessage(groupId, errorMsg);
      } catch (sendError) {
        logger.error('Failed to send error message:', sendError);
      }
    }
  }

  /**
   * Filter the triggering message(s) out of history to avoid self-duplication.
   * Uses strict sender+timestamp equality rather than the spec's >= approach,
   * because >= would incorrectly exclude later messages from the same sender
   * that arrived while the request was queued.
   */
  private filterTriggerMessage(history: Message[], item: QueueItem): Message[] {
    if (item.kind === 'single') {
      const { sender, timestamp } = item.request;
      return history.filter(m => !(m.sender === sender && m.timestamp === timestamp));
    }
    // For coalesced: filter out all triggering messages
    const triggers = new Set(item.requests.map(r => `${r.sender}:${r.timestamp}`));
    return history.filter(m => !triggers.has(`${m.sender}:${m.timestamp}`));
  }

  /** Assemble additional context (dossiers, memories, skills, persona). */
  private assembleAdditionalContext(groupId: string): {
    additionalContext: string | undefined;
    nameMap: Map<string, string>;
    personaPrompt: string | undefined;
  } {
    const contextParts: string[] = [];
    const dossiers = this.storage.getDossiersByGroup(groupId);
    const nameMap = new Map(dossiers.map(d => [d.personId, d.displayName]));
    if (dossiers.length > 0) {
      const entries = dossiers.map(d => {
        const parts = [`- ${d.displayName} (${d.personId})`];
        if (d.notes) parts.push(`  ${d.notes}`);
        return parts.join('\n');
      });
      contextParts.push(`## People in this group\n${entries.join('\n')}`);
    }
    const MEMORY_CONTEXT_BUDGET = 2000;
    const memories = this.storage.getMemoriesByGroup(groupId);
    if (memories.length > 0) {
      let tokenTotal = 0;
      const memoryLines: string[] = [];
      for (const m of memories) {
        const line = `- **${m.topic}**: ${m.content}`;
        const tokens = estimateTokens(line);
        if (tokenTotal + tokens > MEMORY_CONTEXT_BUDGET) break;
        tokenTotal += tokens;
        memoryLines.push(line);
      }
      if (memoryLines.length > 0) {
        contextParts.push(`## Group Memory\n${memoryLines.join('\n')}`);
      }
    }
    const skillContent = this.contextBuilder.loadSkillContent();
    if (skillContent) {
      contextParts.push(skillContent);
    }

    const activePersona = this.storage.getActivePersonaForGroup(groupId);
    const personaPrompt = activePersona?.description;

    return {
      additionalContext: contextParts.join('\n\n') || undefined,
      nameMap,
      personaPrompt,
    };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd bot && npx vitest run tests/messageHandler.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add bot/src/messageHandler.ts bot/tests/messageHandler.test.ts
git commit -m "refactor: simplify MessageHandler to expose processRequest, remove handleMessage/handleMessageBatch"
```

---

### Task 8: Wire Everything into the Polling Loop

**Files:**
- Modify: `bot/src/index.ts`

This is the integration step — wire `GroupProcessingQueue`, `ingestMessages`, the simplified `MessageHandler`, and `TypingIndicatorManager` together in the polling loop.

- [ ] **Step 1: Rewrite the polling loop in index.ts**

Key changes to `bot/src/index.ts`:

1. Import the new modules
2. Create `GroupProcessingQueue` with a callback that wraps `messageHandler.processRequest` in `typingManager.withTyping`
3. Create `MessageDeduplicator` at the top level (it used to live inside MessageHandler)
4. Replace the `handleMessageBatch` call with `ingestMessages`
5. Add `queue.shutdown()` to the shutdown handler

```typescript
import { ClaudeCLIClient, spawnLimiter } from './claudeClient';
import { Config } from './config';
import { GroupProcessingQueue } from './groupProcessingQueue';
import { logger } from './logger';
import { MessageDeduplicator } from './messageDeduplicator';
import { MessageHandler } from './messageHandler';
import { ingestMessages } from './messageIngestion';
import { sendStartupNotification, sendErrorNotification } from './notifications';
import { PollingBackoff } from './pollingBackoff';
import { RecurringReminderExecutor } from './recurringReminderExecutor';
import { ReminderScheduler } from './reminderScheduler';
import { SignalClient } from './signalClient';
import { Storage } from './storage';
import { TypingIndicatorManager } from './typingIndicator';

async function main() {
  logger.info('Starting Signal Family Bot...');

  const config = Config.load();
  logger.success('Configuration loaded');

  const storage = new Storage(config.dbPath);
  logger.success(`Database initialized at ${config.dbPath}`);

  const llmClient = new ClaudeCLIClient(config.claude.maxTurns);
  logger.success('Claude CLI client initialized');

  const signalClient = new SignalClient(config.signalCliUrl, config.botPhoneNumber);
  logger.success('Signal client initialized');

  const appConfig = {
    dbPath: config.dbPath,
    timezone: config.timezone,
    githubRepo: config.githubRepo,
    sourceRoot: config.sourceRoot,
    signalCliUrl: config.signalCliUrl,
    botPhoneNumber: config.botPhoneNumber,
    attachmentsDir: config.attachmentsDir,
    whisperModelPath: config.whisperModelPath,
    darkFactoryEnabled: config.darkFactoryEnabled,
    darkFactoryProjectRoot: config.darkFactoryProjectRoot,
  };

  const recurringExecutor = new RecurringReminderExecutor(appConfig, signalClient, config.claude.maxTurns, groupId =>
    storage.groupSettings.getToolNotifications(groupId),
  );
  logger.success('Recurring reminder executor initialized');

  const reminderScheduler = new ReminderScheduler(
    storage.reminders,
    signalClient,
    storage.recurringReminders,
    recurringExecutor,
  );
  logger.success('Reminder scheduler initialized');

  const messageHandler = new MessageHandler(
    {
      storage,
      llmClient,
      signalClient,
      appConfig,
    },
    {
      systemPrompt: config.systemPrompt,
      contextWindowSize: config.contextWindowSize,
      contextTokenBudget: config.contextTokenBudget,
      messageRetentionCount: config.messageRetentionCount,
      attachmentRetentionDays: config.attachmentRetentionDays,
      collaborativeTestingMode: config.collaborativeTestingMode,
      mentionTriggers: config.mentionTriggers,
    },
  );
  logger.success(`Message handler initialized (triggers: ${config.mentionTriggers.join(', ')})`);

  const typingManager = new TypingIndicatorManager(signalClient);
  const deduplicator = new MessageDeduplicator();

  // Build the processing callback: typing indicator + processRequest
  const processingQueue = new GroupProcessingQueue(async (item) => {
    const groupId = item.kind === 'single' ? item.request.groupId : item.requests[0].groupId;
    await typingManager.withTyping(groupId, () => messageHandler.processRequest(item));
  });
  logger.success('Group processing queue initialized');

  // Compute storeOnly group set
  const storeOnlyGroupIds = new Set<string>();
  if (config.testChannelOnly && config.testGroupId) {
    // In test-channel-only mode, all groups except the test group are storeOnly
    // We can't pre-compute this because we don't know all group IDs.
    // Instead, we'll compute per-message in the loop.
  }
  for (const id of config.excludeGroupIds) {
    storeOnlyGroupIds.add(id);
  }

  if (config.testChannelOnly) {
    logger.warn(`*** TEST CHANNEL ONLY MODE — only processing group ${config.testGroupId} ***`);
  }
  if (config.excludeGroupIds.length > 0) {
    logger.warn(`*** EXCLUDING ${config.excludeGroupIds.length} group(s) from LLM processing ***`);
  }

  // Graceful shutdown
  const shutdown = () => {
    logger.info('Shutting down gracefully...');
    processingQueue.shutdown();
    spawnLimiter.killAll();
    logger.close();
    storage.close();
    setTimeout(() => process.exit(0), 2000);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection:', reason);
    sendErrorNotification(signalClient, config, reason).finally(() => {
      process.exit(1);
    });
  });

  // Wait for signal-cli to be ready
  logger.info('Waiting for signal-cli...');
  await signalClient.waitForReady();

  await sendStartupNotification(signalClient, config);

  // Start polling loop
  logger.success('Starting message polling...');
  const REMINDER_CHECK_MS = 30_000;
  const CHECKPOINT_MS = 5 * 60 * 1000;
  let lastReminderCheck = 0;
  let lastCheckpoint = 0;
  const backoff = new PollingBackoff();

  let pollCount = 0;
  let messagesSinceHeartbeat = 0;
  while (true) {
    try {
      pollCount++;
      const messages = await signalClient.receiveMessages();
      backoff.recordSuccess();
      if (messages.length > 0) {
        logger.compact('POLL', `#${pollCount} received ${messages.length} message(s)`);
        messagesSinceHeartbeat += messages.length;
      } else if (pollCount % 30 === 0) {
        logger.debug(`POLL heartbeat: ${pollCount} polls, ${messagesSinceHeartbeat} messages since last heartbeat`);
        messagesSinceHeartbeat = 0;
      }

      // Extract messages
      const extracted: import('./types').ExtractedMessage[] = [];
      for (const signalMsg of messages) {
        const data = signalClient.extractMessageData(signalMsg);
        if (!data) {
          logger.compact('SKIP', `(no data): ${JSON.stringify(signalMsg).substring(0, 200)}`);
          continue;
        }

        const isStoreOnly =
          (config.testChannelOnly && data.groupId !== config.testGroupId) ||
          config.excludeGroupIds.includes(data.groupId);
        if (isStoreOnly) {
          logger.compact('STORED', `[${data.groupId}] ${data.sender}: ${data.content.substring(0, 80)}`);
        } else {
          logger.compact('RECV', `[${data.groupId}] ${data.sender}: ${data.content.substring(0, 80)}`);
        }

        extracted.push(data);
      }

      // Compute effective storeOnly set (testChannelOnly mode adds all non-test groups)
      let effectiveStoreOnly = storeOnlyGroupIds;
      if (config.testChannelOnly && config.testGroupId) {
        effectiveStoreOnly = new Set(storeOnlyGroupIds);
        for (const msg of extracted) {
          if (msg.groupId !== config.testGroupId) {
            effectiveStoreOnly.add(msg.groupId);
          }
        }
      }

      // Ingest messages: store, detect mentions, enqueue
      if (extracted.length > 0) {
        ingestMessages({
          messages: extracted,
          mentionTriggers: config.mentionTriggers,
          botPhoneNumber: config.botPhoneNumber,
          storage,
          signalClient,
          enqueue: (item) => processingQueue.enqueue(item),
          storeOnlyGroupIds: effectiveStoreOnly,
          deduplicator,
          attachmentsDir: config.attachmentsDir,
        });
      }

      // Check for due reminders and run maintenance periodically
      const now = Date.now();
      if (now - lastReminderCheck >= REMINDER_CHECK_MS) {
        lastReminderCheck = now;
        try {
          await reminderScheduler.processDueReminders();
          messageHandler.runMaintenance();
        } catch (error) {
          logger.error('Error processing reminders:', error);
        }
      }

      // Checkpoint less frequently
      if (now - lastCheckpoint >= CHECKPOINT_MS) {
        lastCheckpoint = now;
        try {
          storage.checkpoint();
        } catch (error) {
          logger.error('WAL checkpoint failed:', error);
        }
      }
    } catch (error) {
      logger.error(`[poll #${pollCount}] Error in polling loop:`, error);
      backoff.recordError();
      if (backoff.shouldReconnect()) {
        try {
          logger.info('Attempting signal-cli reconnection...');
          await signalClient.waitForReady();
          logger.success('signal-cli reconnected');
        } catch (reconnectError) {
          logger.error('signal-cli reconnection failed:', reconnectError);
        }
      }
    }

    await new Promise(resolve => setTimeout(resolve, backoff.getDelay()));
  }
}

main().catch(async (error) => {
  logger.error('Fatal error:', error);
  try {
    const config = Config.load();
    if (config.startupNotify) {
      const tempClient = new SignalClient(config.signalCliUrl, config.botPhoneNumber);
      await Promise.race([
        sendErrorNotification(tempClient, config, error),
        new Promise(resolve => setTimeout(resolve, 5000)),
      ]);
    }
  } catch {
    // Config or signal-cli not available — just exit
  }
  process.exit(1);
});
```

- [ ] **Step 2: Verify it compiles**

Run: `cd bot && npx tsc --noEmit`
Expected: No errors (or only pre-existing ones)

- [ ] **Step 3: Run full test suite**

Run: `cd bot && npx vitest run`
Expected: All tests pass. If any old tests fail because they reference removed methods (`handleMessage`, `handleMessageBatch`), they need updating — this should have been caught in Task 7's test rewrite.

- [ ] **Step 4: Commit**

```bash
git add bot/src/index.ts
git commit -m "feat: wire GroupProcessingQueue and ingestMessages into polling loop"
```

---

### Task 9: Remove REALTIME_THRESHOLD_MS Export from Old Location

**Files:**
- Modify: `bot/src/messageHandler.ts` (if `REALTIME_THRESHOLD_MS` was still exported from here)

- [ ] **Step 1: Check for remaining imports of old exports**

Run: `cd bot && grep -r 'REALTIME_THRESHOLD_MS' src/ tests/ --include='*.ts'`

If any files still import `REALTIME_THRESHOLD_MS` from `messageHandler`, update them to import from `messageIngestion` instead.

- [ ] **Step 2: Run full test suite**

Run: `cd bot && npx vitest run`
Expected: All tests PASS

- [ ] **Step 3: Run lint**

Run: `cd bot && npm run check`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: clean up old imports and remove dead code"
```

---

### Task 10: Manual Smoke Test

**Files:** None — this is a verification step.

- [ ] **Step 1: Start mock server and bot**

In terminal 1:
```bash
cd bot && npm run mock-signal
```

In terminal 2:
```bash
cd bot && npm run dev:mock
```

- [ ] **Step 2: Test single mention**

In the mock server terminal, type:
```
claude: what is 2+2?
```
Verify: Bot responds with an answer. Check logs show queue enqueue/worker start/complete messages.

- [ ] **Step 3: Test sequential processing**

Send two mentions rapidly:
```
claude: what is 2+2?
claude: what is the weather?
```
Verify: Both get responses. Logs show second mention was queued until first completed. No duplicate responses.

- [ ] **Step 4: Test non-trigger messages between invocations**

Send:
```
claude: tell me a joke
hey everyone
what's up
claude: another joke
```
Verify: Both mentions get responses. The second response's context should include "hey everyone" and "what's up" in the conversation history.
