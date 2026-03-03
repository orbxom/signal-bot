import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { initializeServer, sendAndReceive, spawnMcpServer as spawnServer } from './helpers/mcpTestHelpers';

describe('signalMcpServer', () => {
  let proc: ChildProcess | null = null;

  afterEach(() => {
    if (proc) {
      proc.kill();
      proc = null;
    }
  });

  function spawnMcpServer(env?: Record<string, string>): ChildProcess {
    proc = spawnServer('signalMcpServer.ts', env);
    return proc;
  }

  it('should respond to initialize request', async () => {
    const server = spawnMcpServer({
      SIGNAL_CLI_URL: 'http://localhost:8080',
      SIGNAL_ACCOUNT: '+61400000000',
      MCP_GROUP_ID: 'test-group-id',
    });
    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0' },
      },
    });

    expect(response.jsonrpc).toBe('2.0');
    expect(response.id).toBe(1);
    const result = response.result as Record<string, unknown>;
    expect((result.serverInfo as Record<string, unknown>).name).toBe('signal-bot-signal');
  });

  it('should list send_message tool', async () => {
    const server = spawnMcpServer({
      SIGNAL_CLI_URL: 'http://localhost:8080',
      SIGNAL_ACCOUNT: '+61400000000',
      MCP_GROUP_ID: 'test-group-id',
    });
    await initializeServer(server);

    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    });

    const result = response.result as { tools: Array<{ name: string }> };
    const toolNames = result.tools.map(t => t.name);
    expect(toolNames).toContain('send_message');
  });

  it('should return error for unknown tool', async () => {
    const server = spawnMcpServer({
      SIGNAL_CLI_URL: 'http://localhost:8080',
      SIGNAL_ACCOUNT: '+61400000000',
      MCP_GROUP_ID: 'test-group-id',
    });
    await initializeServer(server);

    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'nonexistent', arguments: {} },
    });

    const result = response.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown tool');
  });

  it('should return error when message is missing', async () => {
    const server = spawnMcpServer({
      SIGNAL_CLI_URL: 'http://localhost:8080',
      SIGNAL_ACCOUNT: '+61400000000',
      MCP_GROUP_ID: 'test-group-id',
    });
    await initializeServer(server);

    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'send_message', arguments: {} },
    });

    const result = response.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Missing or invalid message');
  });

  it('should list send_image tool', async () => {
    const server = spawnMcpServer({
      SIGNAL_CLI_URL: 'http://localhost:8080',
      SIGNAL_ACCOUNT: '+61400000000',
      MCP_GROUP_ID: 'test-group-id',
    });
    await initializeServer(server);

    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/list',
      params: {},
    });

    const result = response.result as { tools: Array<{ name: string }> };
    const toolNames = result.tools.map(t => t.name);
    expect(toolNames).toContain('send_image');
  });

  it('should return error when imagePath is missing for send_image', async () => {
    const server = spawnMcpServer({
      SIGNAL_CLI_URL: 'http://localhost:8080',
      SIGNAL_ACCOUNT: '+61400000000',
      MCP_GROUP_ID: 'test-group-id',
    });
    await initializeServer(server);

    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: { name: 'send_image', arguments: {} },
    });

    const result = response.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('imagePath');
  });

  it('should return error when image file does not exist for send_image', async () => {
    const server = spawnMcpServer({
      SIGNAL_CLI_URL: 'http://localhost:8080',
      SIGNAL_ACCOUNT: '+61400000000',
      MCP_GROUP_ID: 'test-group-id',
    });
    await initializeServer(server);

    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: { name: 'send_image', arguments: { imagePath: '/tmp/nonexistent-image-12345.png' } },
    });

    const result = response.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });

  it('should return error when SIGNAL_CLI_URL is not configured', async () => {
    const server = spawnMcpServer({
      SIGNAL_CLI_URL: '',
      SIGNAL_ACCOUNT: '+61400000000',
      MCP_GROUP_ID: 'test-group-id',
    });
    await initializeServer(server);

    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'send_message', arguments: { message: 'Hello' } },
    });

    const result = response.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('SIGNAL_CLI_URL');
  });
});
