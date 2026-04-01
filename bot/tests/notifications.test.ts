import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/logger', () => ({
  logger: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    compact: vi.fn(),
    close: vi.fn(),
  },
}));

import { sendErrorNotification, sendStartupNotification } from '../src/notifications';

describe('sendStartupNotification', () => {
  const mockSignalClient = {
    sendMessage: vi.fn().mockResolvedValue(undefined),
  };

  const baseConfig = {
    startupNotify: true,
    testGroupId: 'test-group-123',
    timezone: 'Australia/Sydney',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should send startup message with commit hash from VERSION file', async () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue('abc1234\n');

    await sendStartupNotification(mockSignalClient as any, baseConfig);

    expect(mockSignalClient.sendMessage).toHaveBeenCalledOnce();
    const msg = mockSignalClient.sendMessage.mock.calls[0][1];
    expect(msg).toContain('Bot online');
    expect(msg).toContain('abc1234');
    expect(mockSignalClient.sendMessage.mock.calls[0][0]).toBe('test-group-123');
  });

  it('should use "unknown" when VERSION file is missing', async () => {
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw new Error('ENOENT');
    });

    await sendStartupNotification(mockSignalClient as any, baseConfig);

    const msg = mockSignalClient.sendMessage.mock.calls[0][1];
    expect(msg).toContain('unknown');
  });

  it('should not send when startupNotify is false', async () => {
    await sendStartupNotification(mockSignalClient as any, {
      ...baseConfig,
      startupNotify: false,
    });

    expect(mockSignalClient.sendMessage).not.toHaveBeenCalled();
  });

  it('should not throw if sendMessage fails', async () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue('abc1234\n');
    mockSignalClient.sendMessage.mockRejectedValueOnce(new Error('signal-cli down'));

    await expect(sendStartupNotification(mockSignalClient as any, baseConfig)).resolves.toBeUndefined();
  });
});

describe('sendErrorNotification', () => {
  const mockSignalClient = {
    sendMessage: vi.fn().mockResolvedValue(undefined),
  };

  const baseConfig = {
    startupNotify: true,
    testGroupId: 'test-group-123',
    timezone: 'Australia/Sydney',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should send error message with error details', async () => {
    const error = new Error('Something broke');

    await sendErrorNotification(mockSignalClient as any, baseConfig, error);

    expect(mockSignalClient.sendMessage).toHaveBeenCalledOnce();
    const msg = mockSignalClient.sendMessage.mock.calls[0][1];
    expect(msg).toContain('Bot error');
    expect(msg).toContain('Something broke');
    expect(mockSignalClient.sendMessage.mock.calls[0][0]).toBe('test-group-123');
  });

  it('should include stack trace in error message', async () => {
    const error = new Error('Stack test');

    await sendErrorNotification(mockSignalClient as any, baseConfig, error);

    const msg = mockSignalClient.sendMessage.mock.calls[0][1];
    expect(msg).toContain('Stack test');
    expect(msg).toContain('at '); // stack trace lines
  });

  it('should truncate long error messages to 2000 chars', async () => {
    const error = new Error('x'.repeat(3000));

    await sendErrorNotification(mockSignalClient as any, baseConfig, error);

    const msg = mockSignalClient.sendMessage.mock.calls[0][1];
    expect(msg.length).toBeLessThanOrEqual(2000);
  });

  it('should handle non-Error objects gracefully', async () => {
    await sendErrorNotification(mockSignalClient as any, baseConfig, 'string error');

    const msg = mockSignalClient.sendMessage.mock.calls[0][1];
    expect(msg).toContain('string error');
  });

  it('should not send when startupNotify is false', async () => {
    await sendErrorNotification(mockSignalClient as any, { ...baseConfig, startupNotify: false }, new Error('test'));

    expect(mockSignalClient.sendMessage).not.toHaveBeenCalled();
  });

  it('should not throw if sendMessage fails', async () => {
    mockSignalClient.sendMessage.mockRejectedValueOnce(new Error('signal-cli down'));

    await expect(
      sendErrorNotification(mockSignalClient as any, baseConfig, new Error('test')),
    ).resolves.toBeUndefined();
  });
});
