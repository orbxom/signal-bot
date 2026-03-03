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
    proc = spawnServer('githubMcpServer.ts', env);
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

  it('should list 1 tool', async () => {
    const server = spawnMcpServer();
    await initializeServer(server);
    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });

    const result = response.result as { tools: Array<{ name: string }> };
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('create_feature_request');
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
});
