import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { initializeServer, sendAndReceive, spawnMcpServer as spawnServer } from './helpers/mcpTestHelpers';

describe('GitHub MCP Server', () => {
  let proc: ChildProcess | null = null;

  afterEach(() => {
    if (proc) {
      proc.kill();
      proc = null;
    }
  });

  function spawnMcpServer(env?: Record<string, string>): ChildProcess {
    proc = spawnServer('mcp/servers/github.ts', env);
    return proc;
  }

  it('should respond to initialize request', async () => {
    const server = spawnMcpServer();
    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
    });

    expect(response.jsonrpc).toBe('2.0');
    expect(response.id).toBe(1);
    const result = response.result as Record<string, unknown>;
    expect(result.capabilities).toEqual({ tools: {} });
    const serverInfo = result.serverInfo as Record<string, string>;
    expect(serverInfo.name).toBe('signal-bot-github');
  });

  it('should list 7 tools', async () => {
    const server = spawnMcpServer();
    await initializeServer(server);
    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });

    const result = response.result as { tools: Array<{ name: string }> };
    expect(result.tools).toHaveLength(7);
    const names = result.tools.map(t => t.name);
    expect(names).toContain('create_feature_request');
    expect(names).toContain('list_pull_requests');
    expect(names).toContain('view_pull_request');
    expect(names).toContain('get_pr_diff');
    expect(names).toContain('comment_on_pull_request');
    expect(names).toContain('review_pull_request');
    expect(names).toContain('merge_pull_request');
  });

  it('should return error for unknown tool', async () => {
    const server = spawnMcpServer();
    await initializeServer(server);
    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'nonexistent_tool', arguments: {} },
    });

    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown tool');
  });

  it('should return error for unknown method', async () => {
    const server = spawnMcpServer();
    await initializeServer(server);
    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 4,
      method: 'unknown/method',
    });

    expect(response.error).toBeDefined();
    const error = response.error as { code: number; message: string };
    expect(error.code).toBe(-32601);
  });

  it('should return error when title is missing', async () => {
    const server = spawnMcpServer({ GITHUB_REPO: 'owner/repo' });
    await initializeServer(server);
    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'create_feature_request', arguments: { body: 'some body' } },
    });

    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Missing or invalid title');
  });

  it('should return error when body is missing', async () => {
    const server = spawnMcpServer({ GITHUB_REPO: 'owner/repo' });
    await initializeServer(server);
    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'create_feature_request', arguments: { title: 'some title' } },
    });

    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Missing or invalid body');
  });

  it('should return error when GITHUB_REPO is not set', async () => {
    const server = spawnMcpServer({ GITHUB_REPO: '' });
    await initializeServer(server);
    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: {
        name: 'create_feature_request',
        arguments: { title: 'Test feature', body: 'Test body' },
      },
    });

    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('GITHUB_REPO environment variable is not configured');
  });

  // --- list_pull_requests ---

  it('should return error for list_pull_requests when GITHUB_REPO is not set', async () => {
    const server = spawnMcpServer({ GITHUB_REPO: '' });
    await initializeServer(server);
    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'list_pull_requests', arguments: {} },
    });

    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('GITHUB_REPO environment variable is not configured');
  });

  // --- view_pull_request ---

  it('should return error for view_pull_request when number is missing', async () => {
    const server = spawnMcpServer({ GITHUB_REPO: 'owner/repo' });
    await initializeServer(server);
    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'view_pull_request', arguments: {} },
    });

    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Missing or invalid number');
  });

  // --- get_pr_diff ---

  it('should return error for get_pr_diff when number is missing', async () => {
    const server = spawnMcpServer({ GITHUB_REPO: 'owner/repo' });
    await initializeServer(server);
    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'get_pr_diff', arguments: {} },
    });

    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Missing or invalid number');
  });

  // --- comment_on_pull_request ---

  it('should return error for comment_on_pull_request when number is missing', async () => {
    const server = spawnMcpServer({ GITHUB_REPO: 'owner/repo' });
    await initializeServer(server);
    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: { name: 'comment_on_pull_request', arguments: { body: 'test' } },
    });

    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Missing or invalid number');
  });

  it('should return error for comment_on_pull_request when body is missing', async () => {
    const server = spawnMcpServer({ GITHUB_REPO: 'owner/repo' });
    await initializeServer(server);
    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: { name: 'comment_on_pull_request', arguments: { number: 1 } },
    });

    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Missing or invalid body');
  });

  // --- review_pull_request ---

  it('should return error for review_pull_request when number is missing', async () => {
    const server = spawnMcpServer({ GITHUB_REPO: 'owner/repo' });
    await initializeServer(server);
    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 13,
      method: 'tools/call',
      params: { name: 'review_pull_request', arguments: { event: 'APPROVE' } },
    });

    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Missing or invalid number');
  });

  it('should return error for review_pull_request when event is missing', async () => {
    const server = spawnMcpServer({ GITHUB_REPO: 'owner/repo' });
    await initializeServer(server);
    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 14,
      method: 'tools/call',
      params: { name: 'review_pull_request', arguments: { number: 1 } },
    });

    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Missing or invalid event');
  });

  it('should return error for review_pull_request COMMENT without body', async () => {
    const server = spawnMcpServer({ GITHUB_REPO: 'owner/repo' });
    await initializeServer(server);
    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 17,
      method: 'tools/call',
      params: { name: 'review_pull_request', arguments: { number: 1, event: 'COMMENT' } },
    });

    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Body is required for COMMENT reviews');
  });

  it('should return error for review_pull_request with invalid event', async () => {
    const server = spawnMcpServer({ GITHUB_REPO: 'owner/repo' });
    await initializeServer(server);
    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 15,
      method: 'tools/call',
      params: { name: 'review_pull_request', arguments: { number: 1, event: 'INVALID' } },
    });

    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid event');
  });

  // --- merge_pull_request ---

  it('should return error for merge_pull_request with invalid strategy', async () => {
    const server = spawnMcpServer({ GITHUB_REPO: 'owner/repo' });
    await initializeServer(server);
    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 18,
      method: 'tools/call',
      params: { name: 'merge_pull_request', arguments: { number: 1, strategy: 'fast-forward' } },
    });

    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid strategy');
  });

  it('should return error for merge_pull_request when number is missing', async () => {
    const server = spawnMcpServer({ GITHUB_REPO: 'owner/repo' });
    await initializeServer(server);
    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 16,
      method: 'tools/call',
      params: { name: 'merge_pull_request', arguments: {} },
    });

    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Missing or invalid number');
  });
});
