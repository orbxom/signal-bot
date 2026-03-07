import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

  it('should list 3 tools', async () => {
    const server = spawnMcpServer();
    await initializeServer(server);
    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });
    const result = response.result as { tools: Array<{ name: string }> };
    expect(result.tools).toHaveLength(3);
    const names = result.tools.map(t => t.name).sort();
    expect(names).toEqual(['read_dark_factory', 'send_dark_factory_input', 'start_dark_factory']);
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

  it('should return error when DARK_FACTORY_ENABLED is not set for send_input', async () => {
    const server = spawnMcpServer();
    await initializeServer(server);
    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 20,
      method: 'tools/call',
      params: { name: 'send_dark_factory_input', arguments: { session_name: 'test', input: 'y' } },
    });
    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not enabled');
  });

  it('should return error when session_name is missing for send_input', async () => {
    const server = spawnMcpServer({ DARK_FACTORY_ENABLED: '1' });
    await initializeServer(server);
    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 21,
      method: 'tools/call',
      params: { name: 'send_dark_factory_input', arguments: { input: 'y' } },
    });
    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Missing or invalid session_name');
  });

  it('should return error when both input and special_key are missing for send_input', async () => {
    const server = spawnMcpServer({ DARK_FACTORY_ENABLED: '1' });
    await initializeServer(server);
    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 22,
      method: 'tools/call',
      params: { name: 'send_dark_factory_input', arguments: { session_name: 'test' } },
    });
    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Missing or invalid input');
  });

  it('should return "no session found" for nonexistent session on send_input', async () => {
    const server = spawnMcpServer({ DARK_FACTORY_ENABLED: '1' });
    await initializeServer(server);
    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 23,
      method: 'tools/call',
      params: { name: 'send_dark_factory_input', arguments: { session_name: 'nonexistent', input: 'y' } },
    });
    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No session found');
  });

  describe('read_dark_factory with fake JSONL', () => {
    let proc2: ChildProcess | null = null;
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dark-factory-test-'));
    });

    afterEach(() => {
      if (proc2) {
        proc2.kill();
        proc2 = null;
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    function spawnMcpServer2(env?: Record<string, string>): ChildProcess {
      proc2 = spawnServer('mcp/servers/darkFactory.ts', env);
      return proc2;
    }

    it('should parse assistant messages from JSONL', async () => {
      // Create fake sessions dir and metadata
      const sessionsPath = path.join(tempDir, 'factory', 'sessions');
      fs.mkdirSync(sessionsPath, { recursive: true });

      const sessionName = 'dark-factory-99-1234567890';
      const metadata = {
        sessionName,
        issueNumber: 99,
        launchedAt: new Date(Date.now() - 60000).toISOString(),
      };
      fs.writeFileSync(path.join(sessionsPath, `${sessionName}.json`), JSON.stringify(metadata));

      // Create fake Claude projects dir with JSONL file
      // Path encoding: tempDir (e.g., /tmp/dark-factory-test-abc) -> -tmp-dark-factory-test-abc
      const projectKey = tempDir.replace(/\//g, '-');
      const claudeProjectDir = path.join(tempDir, '.claude', 'projects', projectKey);
      fs.mkdirSync(claudeProjectDir, { recursive: true });

      const jsonlLines = [
        JSON.stringify({
          type: 'user',
          timestamp: new Date().toISOString(),
          message: { role: 'user', content: '/dark-factory issue 99' },
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: new Date().toISOString(),
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Starting dark factory for issue #99.' },
              { type: 'tool_use', name: 'Bash' },
            ],
          },
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: new Date().toISOString(),
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Research complete. Moving to planning.' }],
          },
        }),
      ];
      fs.writeFileSync(path.join(claudeProjectDir, 'test-session.jsonl'), jsonlLines.join('\n'));

      // Spawn server with overridden paths and enabled flag
      const server = spawnMcpServer2({
        DARK_FACTORY_PROJECT_ROOT: tempDir,
        HOME: tempDir,
        DARK_FACTORY_ENABLED: '1',
      });
      await initializeServer(server);

      const response = await sendAndReceive(server, {
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: { name: 'read_dark_factory', arguments: { session_name: sessionName } },
      });

      const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Issue: #99');
      expect(result.content[0].text).toContain('Starting dark factory');
      expect(result.content[0].text).toContain('Research complete');
      expect(result.content[0].text).toContain('Bash');
    });

    it('should return error when session exists in metadata but zellij is not reachable', async () => {
      const sessionsPath = path.join(tempDir, 'factory', 'sessions');
      fs.mkdirSync(sessionsPath, { recursive: true });

      const sessionName = 'dark-factory-99-1234567890';
      const metadata = {
        sessionName,
        issueNumber: 99,
        launchedAt: new Date().toISOString(),
      };
      fs.writeFileSync(path.join(sessionsPath, `${sessionName}.json`), JSON.stringify(metadata));

      const server = spawnMcpServer2({
        DARK_FACTORY_PROJECT_ROOT: tempDir,
        DARK_FACTORY_ENABLED: '1',
      });
      await initializeServer(server);

      const response = await sendAndReceive(server, {
        jsonrpc: '2.0',
        id: 30,
        method: 'tools/call',
        params: { name: 'send_dark_factory_input', arguments: { session_name: sessionName, input: 'y' } },
      });

      const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not reachable');
    });
  });
});
