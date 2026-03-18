import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    success: vi.fn(),
    compact: vi.fn(),
    group: vi.fn(),
    step: vi.fn(),
    groupEnd: vi.fn(),
  },
}));

import { SpawnLimiter } from '../src/spawnLimiter';

function createMockChild() {
  const child = Object.assign(new EventEmitter(), {
    kill: vi.fn(),
    killed: false,
    pid: Math.floor(Math.random() * 10000),
  });
  return child;
}

describe('SpawnLimiter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('acquire and release', () => {
    it('resolves immediately when slots are available', async () => {
      const limiter = new SpawnLimiter(2);
      await limiter.acquire(); // should resolve immediately
      await limiter.acquire(); // should resolve immediately
    });

    it('queues when all slots are taken', async () => {
      const limiter = new SpawnLimiter(2);
      await limiter.acquire();
      await limiter.acquire();

      let thirdResolved = false;
      const thirdPromise = limiter.acquire().then(() => {
        thirdResolved = true;
      });

      // Allow microtasks to flush
      await Promise.resolve();
      expect(thirdResolved).toBe(false);

      limiter.release();
      await thirdPromise;
      expect(thirdResolved).toBe(true);
    });

    it('releases slot on release() allowing queued acquire to proceed', async () => {
      const limiter = new SpawnLimiter(1);
      await limiter.acquire();

      let secondResolved = false;
      const secondPromise = limiter.acquire().then(() => {
        secondResolved = true;
      });

      await Promise.resolve();
      expect(secondResolved).toBe(false);

      limiter.release();
      await secondPromise;
      expect(secondResolved).toBe(true);
    });
  });

  describe('trackChild', () => {
    it('adds child to tracked set', () => {
      const limiter = new SpawnLimiter(2);
      const child = createMockChild();

      limiter.trackChild(child as any);
      expect(limiter.getActiveCount()).toBe(1);
    });

    it('auto-removes child on close event', () => {
      const limiter = new SpawnLimiter(2);
      const child = createMockChild();

      limiter.trackChild(child as any);
      expect(limiter.getActiveCount()).toBe(1);

      child.emit('close', 0);
      expect(limiter.getActiveCount()).toBe(0);
    });

    it('tracks multiple children', () => {
      const limiter = new SpawnLimiter(3);
      const child1 = createMockChild();
      const child2 = createMockChild();

      limiter.trackChild(child1 as any);
      limiter.trackChild(child2 as any);
      expect(limiter.getActiveCount()).toBe(2);

      child1.emit('close', 0);
      expect(limiter.getActiveCount()).toBe(1);
    });
  });

  describe('killAll', () => {
    it('sends SIGTERM to all tracked children', () => {
      const limiter = new SpawnLimiter(2);
      const child1 = createMockChild();
      const child2 = createMockChild();

      limiter.trackChild(child1 as any);
      limiter.trackChild(child2 as any);

      limiter.killAll();

      expect(child1.kill).toHaveBeenCalledWith('SIGTERM');
      expect(child2.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('sends SIGKILL after timeout if children have not exited', async () => {
      vi.useFakeTimers();
      const limiter = new SpawnLimiter(2);
      const child1 = createMockChild();

      limiter.trackChild(child1 as any);

      limiter.killAll(3000);

      expect(child1.kill).toHaveBeenCalledWith('SIGTERM');
      expect(child1.kill).not.toHaveBeenCalledWith('SIGKILL');

      // Advance time past the SIGKILL timeout
      vi.advanceTimersByTime(3000);

      expect(child1.kill).toHaveBeenCalledWith('SIGKILL');
      vi.useRealTimers();
    });

    it('does not send SIGKILL if child exits before timeout', async () => {
      vi.useFakeTimers();
      const limiter = new SpawnLimiter(2);
      const child1 = createMockChild();

      limiter.trackChild(child1 as any);

      limiter.killAll(3000);

      expect(child1.kill).toHaveBeenCalledWith('SIGTERM');

      // Child exits before timeout
      child1.emit('close', 0);

      // Advance time past the SIGKILL timeout
      vi.advanceTimersByTime(3000);

      // SIGKILL should NOT have been called since child already exited
      expect(child1.kill).not.toHaveBeenCalledWith('SIGKILL');
      vi.useRealTimers();
    });

    it('handles kill errors gracefully', () => {
      const limiter = new SpawnLimiter(2);
      const child = createMockChild();
      child.kill.mockImplementation(() => {
        throw new Error('Process already dead');
      });

      limiter.trackChild(child as any);

      // Should not throw
      expect(() => limiter.killAll()).not.toThrow();
    });
  });

  describe('getActiveCount', () => {
    it('returns 0 when no children tracked', () => {
      const limiter = new SpawnLimiter(2);
      expect(limiter.getActiveCount()).toBe(0);
    });

    it('reflects current tracked child count', () => {
      const limiter = new SpawnLimiter(3);
      const child1 = createMockChild();
      const child2 = createMockChild();

      expect(limiter.getActiveCount()).toBe(0);
      limiter.trackChild(child1 as any);
      expect(limiter.getActiveCount()).toBe(1);
      limiter.trackChild(child2 as any);
      expect(limiter.getActiveCount()).toBe(2);

      child1.emit('close', 0);
      expect(limiter.getActiveCount()).toBe(1);
      child2.emit('close', 0);
      expect(limiter.getActiveCount()).toBe(0);
    });
  });
});
