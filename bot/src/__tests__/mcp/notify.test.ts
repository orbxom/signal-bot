import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock fetch globally before importing module
const mockFetch = vi.fn().mockResolvedValue({ ok: true });
vi.stubGlobal('fetch', mockFetch);

import { sendToolNotification, withNotification } from '../../mcp/notify';
import { error, ok } from '../../mcp/result';

describe('sendToolNotification', () => {
  beforeEach(() => {
    mockFetch.mockClear();
    process.env.SIGNAL_CLI_URL = 'http://localhost:9090';
    process.env.SIGNAL_ACCOUNT = '+61400000000';
    process.env.MCP_GROUP_ID = 'test-group-123';
    process.env.TOOL_NOTIFICATIONS_ENABLED = '1';
  });

  afterEach(() => {
    delete process.env.SIGNAL_CLI_URL;
    delete process.env.SIGNAL_ACCOUNT;
    delete process.env.MCP_GROUP_ID;
    delete process.env.TOOL_NOTIFICATIONS_ENABLED;
  });

  it('sends message when TOOL_NOTIFICATIONS_ENABLED=1', async () => {
    await sendToolNotification('reminder set for 5pm');

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:9090/api/v1/rpc');
    const body = JSON.parse(opts.body);
    expect(body.method).toBe('send');
    expect(body.params.account).toBe('+61400000000');
    expect(body.params.groupId).toBe('test-group-123');
    expect(body.params.message).toContain('Done');
    expect(body.params.message).toContain('reminder set for 5pm');
  });

  it('does NOT send when TOOL_NOTIFICATIONS_ENABLED is unset', async () => {
    delete process.env.TOOL_NOTIFICATIONS_ENABLED;
    await sendToolNotification('should not send');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does NOT send when TOOL_NOTIFICATIONS_ENABLED is 0', async () => {
    process.env.TOOL_NOTIFICATIONS_ENABLED = '0';
    await sendToolNotification('should not send');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does NOT send when SIGNAL_CLI_URL is missing', async () => {
    delete process.env.SIGNAL_CLI_URL;
    await sendToolNotification('should not send');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('silently handles fetch errors', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network error'));
    // Should not throw
    await sendToolNotification('test message');
  });

  it('prefixes success messages with Done', async () => {
    await sendToolNotification('task completed', true);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.params.message).toMatch(/^Done/);
  });

  it('prefixes failure messages with Failed', async () => {
    await sendToolNotification('could not connect', false);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.params.message).toMatch(/^Failed/);
  });
});

describe('withNotification', () => {
  beforeEach(() => {
    mockFetch.mockClear();
    process.env.SIGNAL_CLI_URL = 'http://localhost:9090';
    process.env.SIGNAL_ACCOUNT = '+61400000000';
    process.env.MCP_GROUP_ID = 'test-group-123';
    process.env.TOOL_NOTIFICATIONS_ENABLED = '1';
  });

  afterEach(() => {
    delete process.env.SIGNAL_CLI_URL;
    delete process.env.SIGNAL_ACCOUNT;
    delete process.env.MCP_GROUP_ID;
    delete process.env.TOOL_NOTIFICATIONS_ENABLED;
  });

  it('sends success notification and returns result on success', async () => {
    const result = await withNotification('task done', 'task failed', () => ok('all good'));

    expect(result).toEqual(ok('all good'));
    expect(mockFetch).toHaveBeenCalledOnce();
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.params.message).toContain('Done');
    expect(body.params.message).toContain('task done');
  });

  it('sends error notification when handler throws', async () => {
    const result = await withNotification('task done', 'task failed', () => {
      throw new Error('boom');
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual({ type: 'text', text: 'boom' });
    expect(mockFetch).toHaveBeenCalledOnce();
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.params.message).toContain('Failed');
    expect(body.params.message).toContain('task failed');
    expect(body.params.message).toContain('boom');
  });

  it('sends error notification when handler returns error result', async () => {
    const result = await withNotification('task done', 'task failed', () => error('bad input'));

    expect(result.isError).toBe(true);
    expect(mockFetch).toHaveBeenCalledOnce();
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.params.message).toContain('Failed');
    expect(body.params.message).toContain('task failed');
    expect(body.params.message).toContain('bad input');
  });

  it('supports callback for dynamic success messages', async () => {
    const result = await withNotification(
      (r) => {
        const text = r.content[0] && 'text' in r.content[0] ? r.content[0].text : '';
        return `completed: ${text}`;
      },
      'task failed',
      () => ok('42'),
    );

    expect(result).toEqual(ok('42'));
    expect(mockFetch).toHaveBeenCalledOnce();
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.params.message).toContain('Done');
    expect(body.params.message).toContain('completed: 42');
  });

  it('preserves catchErrors error prefix in returned result', async () => {
    const result = await withNotification(
      'task done',
      'task failed',
      () => {
        throw new Error('disk full');
      },
      'Save error',
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual({ type: 'text', text: 'Save error: disk full' });
  });

  it('does NOT notify when notifications disabled', async () => {
    delete process.env.TOOL_NOTIFICATIONS_ENABLED;

    const result = await withNotification('task done', 'task failed', () => ok('quiet'));

    expect(result).toEqual(ok('quiet'));
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
