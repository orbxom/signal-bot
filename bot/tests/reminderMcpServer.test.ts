// We test the MCP server by importing its handler logic indirectly through the storage layer,
// and by spawning it as a child process to test the full stdio protocol.
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('Reminder MCP Server', () => {
  let testDir: string;
  let dbPath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'mcp-server-test-'));
    dbPath = join(testDir, 'test.db');
  });

  afterEach(() => {
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  function spawnMcpServer(env: Record<string, string> = {}): ChildProcess {
    return spawn('npx', ['tsx', join(__dirname, '../src/reminderMcpServer.ts')], {
      env: {
        ...process.env,
        DB_PATH: dbPath,
        MCP_GROUP_ID: 'test-group-1',
        MCP_SENDER: '+61400000000',
        TZ: 'Australia/Sydney',
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  async function sendAndReceive(proc: ChildProcess, message: object): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout waiting for MCP response')), 10000);
      const handler = (data: Buffer) => {
        const line = data.toString().trim();
        if (!line) return;
        try {
          const response = JSON.parse(line);
          clearTimeout(timeout);
          proc.stdout.removeListener('data', handler);
          resolve(response);
        } catch {
          // partial data, wait for more
        }
      };
      proc.stdout.on('data', handler);
      proc.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }

  async function initializeServer(proc: ChildProcess): Promise<void> {
    await sendAndReceive(proc, {
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
    });
    // Send initialized notification (no response expected)
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  }

  it('should respond to initialize request', async () => {
    const proc = spawnMcpServer();
    try {
      const response = await sendAndReceive(proc, {
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
      expect(serverInfo.name).toBe('signal-bot-reminders');
    } finally {
      proc.kill();
    }
  });

  it('should list 3 tools', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);
      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
      });

      const result = response.result as { tools: Array<{ name: string }> };
      expect(result.tools).toHaveLength(3);
      expect(result.tools.map(t => t.name)).toEqual(['set_reminder', 'list_reminders', 'cancel_reminder']);
    } finally {
      proc.kill();
    }
  });

  it('should set a reminder via tools/call', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);
      const dueAt = Date.now() + 3600000; // 1 hour from now
      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'set_reminder',
          arguments: { reminderText: 'Doctor appointment', dueAt },
        },
      });

      const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Reminder #1');
      expect(result.content[0].text).toContain('Doctor appointment');
    } finally {
      proc.kill();
    }
  });

  it('should list reminders after setting one', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);
      const dueAt = Date.now() + 3600000;

      // Set a reminder
      await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'set_reminder', arguments: { reminderText: 'Buy groceries', dueAt } },
      });

      // Now call list_reminders tool
      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'list_reminders', arguments: {} },
      });

      const result = response.result as { content: Array<{ text: string }> };
      expect(result.content[0].text).toContain('Buy groceries');
      expect(result.content[0].text).toContain('#1');
    } finally {
      proc.kill();
    }
  });

  it('should cancel a reminder', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);
      const dueAt = Date.now() + 3600000;

      // Set a reminder
      await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'set_reminder', arguments: { reminderText: 'Cancel me', dueAt } },
      });

      // Cancel it
      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'cancel_reminder', arguments: { reminderId: 1 } },
      });

      const result = response.result as { content: Array<{ text: string }> };
      expect(result.content[0].text).toContain('cancelled');

      // Verify list is empty
      const listResponse = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'list_reminders', arguments: {} },
      });

      const listResult = listResponse.result as { content: Array<{ text: string }> };
      expect(listResult.content[0].text).toContain('No pending reminders');
    } finally {
      proc.kill();
    }
  });

  it('should reject past due dates', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);
      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'set_reminder',
          arguments: { reminderText: 'Too late', dueAt: Date.now() - 60000 },
        },
      });

      const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('future');
    } finally {
      proc.kill();
    }
  });

  it('should return error for unknown tool', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);
      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'nonexistent_tool', arguments: {} },
      });

      const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unknown tool');
    } finally {
      proc.kill();
    }
  });
});
