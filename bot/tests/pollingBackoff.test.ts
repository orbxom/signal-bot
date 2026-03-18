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

import { PollingBackoff } from '../src/pollingBackoff';

describe('PollingBackoff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getDelay', () => {
    it('returns baseDelay when no errors recorded', () => {
      const backoff = new PollingBackoff();
      expect(backoff.getDelay()).toBe(2000);
    });

    it('returns baseDelay * 2^errorCount after errors', () => {
      const backoff = new PollingBackoff();
      backoff.recordError();
      expect(backoff.getDelay()).toBe(4000); // 2000 * 2^1

      backoff.recordError();
      expect(backoff.getDelay()).toBe(8000); // 2000 * 2^2

      backoff.recordError();
      expect(backoff.getDelay()).toBe(16000); // 2000 * 2^3
    });

    it('caps delay at maxDelay', () => {
      const backoff = new PollingBackoff({ baseDelay: 2000, maxDelay: 10000 });
      backoff.recordError();
      backoff.recordError();
      backoff.recordError();
      backoff.recordError(); // 2000 * 2^4 = 32000, but capped at 10000
      expect(backoff.getDelay()).toBe(10000);
    });

    it('uses custom baseDelay and maxDelay', () => {
      const backoff = new PollingBackoff({ baseDelay: 1000, maxDelay: 5000 });
      expect(backoff.getDelay()).toBe(1000);
      backoff.recordError();
      expect(backoff.getDelay()).toBe(2000); // 1000 * 2^1
    });
  });

  describe('recordSuccess', () => {
    it('resets delay back to baseDelay', () => {
      const backoff = new PollingBackoff();
      backoff.recordError();
      backoff.recordError();
      expect(backoff.getDelay()).toBe(8000);

      backoff.recordSuccess();
      expect(backoff.getDelay()).toBe(2000);
    });
  });

  describe('shouldReconnect', () => {
    it('returns false below threshold', () => {
      const backoff = new PollingBackoff();
      backoff.recordError();
      expect(backoff.shouldReconnect()).toBe(false);

      backoff.recordError();
      expect(backoff.shouldReconnect()).toBe(false);

      backoff.recordError();
      expect(backoff.shouldReconnect()).toBe(false);

      backoff.recordError();
      expect(backoff.shouldReconnect()).toBe(false);
    });

    it('returns true at threshold (every N consecutive errors)', () => {
      const backoff = new PollingBackoff(); // default threshold = 5
      for (let i = 0; i < 4; i++) {
        backoff.recordError();
      }
      expect(backoff.shouldReconnect()).toBe(false);

      backoff.recordError(); // 5th error
      expect(backoff.shouldReconnect()).toBe(true);
    });

    it('returns true again at multiples of threshold', () => {
      const backoff = new PollingBackoff({ reconnectThreshold: 3 });
      for (let i = 0; i < 3; i++) backoff.recordError();
      expect(backoff.shouldReconnect()).toBe(true);

      for (let i = 0; i < 3; i++) backoff.recordError();
      expect(backoff.shouldReconnect()).toBe(true); // 6th error
    });

    it('returns false after success resets the count', () => {
      const backoff = new PollingBackoff({ reconnectThreshold: 3 });
      for (let i = 0; i < 3; i++) backoff.recordError();
      expect(backoff.shouldReconnect()).toBe(true);

      backoff.recordSuccess();
      backoff.recordError();
      expect(backoff.shouldReconnect()).toBe(false);
    });

    it('uses custom reconnect threshold', () => {
      const backoff = new PollingBackoff({ reconnectThreshold: 2 });
      backoff.recordError();
      expect(backoff.shouldReconnect()).toBe(false);

      backoff.recordError(); // 2nd error
      expect(backoff.shouldReconnect()).toBe(true);
    });
  });
});
