import { logger } from './logger';
import type { QueueItem } from './types';

export interface GroupProcessingQueueOptions {
  /** Maximum time (ms) a single item can process before the lock is released. Default: 360000 (6 min) */
  ttlMs?: number;
  /** Maximum pending items per group. Items beyond this are dropped. Default: 10 */
  maxQueueSize?: number;
}

interface GroupState {
  queue: QueueItem[];
  processing: boolean;
  lockTimeout: ReturnType<typeof setTimeout> | null;
}

export class GroupProcessingQueue {
  private groups = new Map<string, GroupState>();
  private processCallback: (item: QueueItem) => Promise<void>;
  private stopped = false;
  private ttlMs: number;
  private maxQueueSize: number;

  constructor(processCallback: (item: QueueItem) => Promise<void>, options?: GroupProcessingQueueOptions) {
    this.processCallback = processCallback;
    this.ttlMs = options?.ttlMs ?? 360_000;
    this.maxQueueSize = options?.maxQueueSize ?? 10;
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
      logger.warn(`Queue cap reached [${groupId}]: dropping item (max=${this.maxQueueSize})`);
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
        const item = state.queue.shift();
        if (!item) break;
        const start = Date.now();
        logger.info(`Queue worker start [${groupId}]`);

        try {
          // Note: The TTL covers the entire processCallback duration, including
          // any SpawnLimiter wait time. The spec recommends starting the timer
          // after acquire(), but spawnPromise encapsulates acquire/release
          // internally. With a 6-minute TTL vs 5-minute Claude timeout, there's
          // 1 minute of buffer. In the unlikely worst case (5min slot wait +
          // 5min Claude), the TTL could fire prematurely — but the family bot
          // has few groups, making sustained slot contention very unlikely.
          //
          // If TTL fires, Promise.race resolves but the hung callback keeps
          // running in the background, holding its SpawnLimiter slot. The hung
          // process will be killed by the CLI's own timeout, then SpawnLimiter
          // releases the slot.
          await Promise.race([
            this.processCallback(item),
            new Promise<void>((_, reject) => {
              state.lockTimeout = setTimeout(() => {
                reject(new Error(`TTL expired after ${this.ttlMs}ms`));
              }, this.ttlMs);
            }),
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
}
