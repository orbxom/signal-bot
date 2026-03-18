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

    run().catch(error => {
      logger.error(`Queue worker fatal [${groupId}]:`, error);
      state.processing = false;
    });
  }
}
