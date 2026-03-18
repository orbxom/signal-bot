import type { ChildProcess } from 'node:child_process';

export class SpawnLimiter {
  private available: number;
  private readonly maxConcurrency: number;
  private queue: Array<() => void> = [];
  private children = new Set<ChildProcess>();

  constructor(maxConcurrency = 2) {
    this.maxConcurrency = maxConcurrency;
    this.available = maxConcurrency;
  }

  acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return Promise.resolve();
    }
    return new Promise<void>(resolve => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else if (this.available < this.maxConcurrency) {
      this.available++;
    }
  }

  trackChild(child: ChildProcess): void {
    this.children.add(child);
    child.on('close', () => {
      this.children.delete(child);
    });
  }

  killAll(timeoutMs = 5000): void {
    const childrenSnapshot = [...this.children];
    for (const child of childrenSnapshot) {
      try {
        child.kill('SIGTERM');
      } catch {
        // Process may already be dead
      }
    }

    setTimeout(() => {
      for (const child of childrenSnapshot) {
        if (this.children.has(child)) {
          try {
            child.kill('SIGKILL');
          } catch {
            // Process may already be dead
          }
        }
      }
    }, timeoutMs);
  }

  getActiveCount(): number {
    return this.children.size;
  }
}
