import { type ChildProcess, spawn } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

function spawnTestServer(): ChildProcess {
  return spawn('npx', ['tsx', join(__dirname, 'testServer.ts')], {
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function sendAndReceive(proc: ChildProcess, message: object, timeoutMs = 10000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timeout waiting for MCP response')), timeoutMs);
    const handler = (data: Buffer) => {
      const line = data.toString().trim();
      if (!line) return;
      try {
        const response = JSON.parse(line);
        clearTimeout(timeout);
        proc.stdout?.removeListener('data', handler);
        resolve(response);
      } catch {
        // partial data, wait for more
      }
    };
    proc.stdout?.on('data', handler);
    proc.stdin?.write(`${JSON.stringify(message)}\n`);
  });
}

async function initializeServer(proc: ChildProcess): Promise<void> {
  await sendAndReceive(proc, {
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
  });
  proc.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
}

describe('mcp/runServer', () => {
  let proc: ChildProcess | null = null;

  afterEach(() => {
    if (proc) {
      proc.kill();
      proc = null;
    }
  });

  it('handles initialize request', async () => {
    proc = spawnTestServer();
    const response = await sendAndReceive(proc, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
    });

    expect(response.jsonrpc).toBe('2.0');
    expect(response.id).toBe(1);
    const result = response.result as Record<string, unknown>;
    expect(result.protocolVersion).toBe('2025-03-26');
    expect(result.capabilities).toEqual({ tools: {} });
    const serverInfo = result.serverInfo as Record<string, string>;
    expect(serverInfo.name).toBe('test-server');
    expect(serverInfo.version).toBe('1.0.0');
  });

  it('handles tools/list request', async () => {
    proc = spawnTestServer();
    await initializeServer(proc);

    const response = await sendAndReceive(proc, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });

    const result = response.result as { tools: Array<{ name: string }> };
    expect(result.tools).toHaveLength(2);
    expect(result.tools.map(t => t.name)).toEqual(['greet', 'fail']);
  });

  it('handles tools/call request and dispatches to handler', async () => {
    proc = spawnTestServer();
    await initializeServer(proc);

    const response = await sendAndReceive(proc, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'greet', arguments: { name: 'World' } },
    });

    const result = response.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toBe('Hello, World!');
  });

  it('handles unknown tool name', async () => {
    proc = spawnTestServer();
    await initializeServer(proc);

    const response = await sendAndReceive(proc, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'nonexistent', arguments: {} },
    });

    const result = response.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown tool');
  });

  it('calls onInit on startup', async () => {
    proc = spawnTestServer();

    // Wait for stderr output confirming onInit ran
    const stderrOutput = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout waiting for stderr')), 10000);
      const handler = (data: Buffer) => {
        const text = data.toString();
        if (text.includes('test-server initialized')) {
          clearTimeout(timeout);
          proc?.stderr?.removeListener('data', handler);
          resolve(text);
        }
      };
      proc?.stderr?.on('data', handler);

      // Send initialize to trigger the server to start processing
      proc?.stdin?.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 0,
          method: 'initialize',
          params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
        })}\n`,
      );
    });

    expect(stderrOutput).toContain('test-server initialized');
  });
});
