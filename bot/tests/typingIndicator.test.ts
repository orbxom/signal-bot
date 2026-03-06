import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type TypingClient, TypingIndicatorManager } from '../src/typingIndicator';

describe('TypingIndicatorManager', () => {
  let mockClient: TypingClient;

  beforeEach(() => {
    mockClient = {
      sendTyping: vi.fn().mockResolvedValue(undefined),
      stopTyping: vi.fn().mockResolvedValue(undefined),
    };
  });

  it('should start typing indicator before executing function', async () => {
    const manager = new TypingIndicatorManager(mockClient);
    const callOrder: string[] = [];

    mockClient.sendTyping = vi.fn().mockImplementation(async () => {
      callOrder.push('sendTyping');
    });

    await manager.withTyping('g1', async () => {
      callOrder.push('fn');
      return 'result';
    });

    expect(callOrder[0]).toBe('sendTyping');
    expect(callOrder[1]).toBe('fn');
  });

  it('should stop typing indicator after function completes', async () => {
    const manager = new TypingIndicatorManager(mockClient);

    await manager.withTyping('g1', async () => 'result');

    expect(mockClient.stopTyping).toHaveBeenCalledWith('g1');
  });

  it('should stop typing indicator even when function throws', async () => {
    const manager = new TypingIndicatorManager(mockClient);

    await expect(
      manager.withTyping('g1', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(mockClient.stopTyping).toHaveBeenCalledWith('g1');
  });

  it('should return the function result', async () => {
    const manager = new TypingIndicatorManager(mockClient);

    const result = await manager.withTyping('g1', async () => 42);

    expect(result).toBe(42);
  });

  it('should still call function when sendTyping fails', async () => {
    mockClient.sendTyping = vi.fn().mockRejectedValue(new Error('Typing failed'));
    const manager = new TypingIndicatorManager(mockClient);

    const result = await manager.withTyping('g1', async () => 'still works');

    expect(result).toBe('still works');
  });

  it('should not throw when stopTyping fails', async () => {
    mockClient.stopTyping = vi.fn().mockRejectedValue(new Error('Stop failed'));
    const manager = new TypingIndicatorManager(mockClient);

    const result = await manager.withTyping('g1', async () => 'result');

    expect(result).toBe('result');
  });

  describe('typing interval refresh', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should refresh typing indicator every 10 seconds during long-running calls', async () => {
      const manager = new TypingIndicatorManager(mockClient);

      // Simulate a 25-second operation
      const promise = manager.withTyping(
        'g1',
        () =>
          new Promise(resolve => {
            setTimeout(() => resolve('done'), 25_000);
          }),
      );

      // Initial sendTyping call
      await vi.advanceTimersByTimeAsync(0);
      expect(mockClient.sendTyping).toHaveBeenCalledTimes(1);

      // After 10s, interval fires
      await vi.advanceTimersByTimeAsync(10_000);
      expect(mockClient.sendTyping).toHaveBeenCalledTimes(2);

      // After 20s, interval fires again
      await vi.advanceTimersByTimeAsync(10_000);
      expect(mockClient.sendTyping).toHaveBeenCalledTimes(3);

      // Let the operation resolve at 25s
      await vi.advanceTimersByTimeAsync(5_000);
      await promise;

      expect(mockClient.stopTyping).toHaveBeenCalledWith('g1');
    });

    it('should clear typing interval when function errors', async () => {
      const manager = new TypingIndicatorManager(mockClient);

      const promise = manager
        .withTyping(
          'g1',
          () =>
            new Promise((_, reject) => {
              setTimeout(() => reject(new Error('LLM failed')), 15_000);
            }),
        )
        .catch(() => {});

      // Initial sendTyping + one interval tick at 10s
      await vi.advanceTimersByTimeAsync(10_000);
      expect(mockClient.sendTyping).toHaveBeenCalledTimes(2);

      // Let the function reject at 15s
      await vi.advanceTimersByTimeAsync(5_000);
      await promise;

      // Reset the mock call count to verify no more interval calls
      (mockClient.sendTyping as ReturnType<typeof vi.fn>).mockClear();

      // Advance well past the next interval tick
      await vi.advanceTimersByTimeAsync(20_000);
      expect(mockClient.sendTyping).not.toHaveBeenCalled();

      expect(mockClient.stopTyping).toHaveBeenCalledWith('g1');
    });
  });
});
