import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { initializeServer, sendAndReceive, spawnMcpServer as spawnServer } from './helpers/mcpTestHelpers';

describe('Dark Factory MCP Server', () => {
  let proc: ChildProcess | null = null;

  afterEach(() => {
    if (proc) {
      proc.kill();
      proc = null;
    }
  });

  function spawnMcpServer(env?: Record<string, string>): ChildProcess {
    proc = spawnServer('mcp/servers/darkFactory.ts', env);
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
    const serverInfo = result.serverInfo as Record<string, string>;
    expect(serverInfo.name).toBe('signal-bot-dark-factory');
  });

  it('should list 2 tools', async () => {
    const server = spawnMcpServer();
    await initializeServer(server);
    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });
    const result = response.result as { tools: Array<{ name: string }> };
    expect(result.tools).toHaveLength(2);
    const names = result.tools.map(t => t.name).sort();
    expect(names).toEqual(['read_dark_factory', 'start_dark_factory']);
  });

  it('should return error when DARK_FACTORY_ENABLED is not set', async () => {
    const server = spawnMcpServer();
    await initializeServer(server);
    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'start_dark_factory', arguments: { issue_number: 42 } },
    });
    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not enabled');
  });

  it('should return error when issue_number is missing for start', async () => {
    const server = spawnMcpServer({ DARK_FACTORY_ENABLED: '1' });
    await initializeServer(server);
    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'start_dark_factory', arguments: {} },
    });
    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Missing or invalid issue_number');
  });

  it('should return "no session found" for nonexistent session', async () => {
    const server = spawnMcpServer({ DARK_FACTORY_ENABLED: '1' });
    await initializeServer(server);
    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'read_dark_factory', arguments: { session_name: 'nonexistent-session' } },
    });

    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No session found');
  });

  it('should return error when session_name is missing for read', async () => {
    const server = spawnMcpServer({ DARK_FACTORY_ENABLED: '1' });
    await initializeServer(server);
    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'read_dark_factory', arguments: {} },
    });
    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Missing or invalid session_name');
  });
});
