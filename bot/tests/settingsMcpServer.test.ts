import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeServer, sendAndReceive, spawnMcpServer as spawnServer } from './helpers/mcpTestHelpers';

describe('Settings MCP Server', () => {
  let testDir: string;
  let dbPath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'settings-mcp-test-'));
    dbPath = join(testDir, 'test.db');
  });

  afterEach(() => {
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  function spawnMcpServer(env: Record<string, string> = {}): ChildProcess {
    return spawnServer('mcp/servers/settings.ts', {
      DB_PATH: dbPath,
      MCP_GROUP_ID: 'test-group-1',
      ...env,
    });
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
      expect(serverInfo.name).toBe('signal-bot-settings');
    } finally {
      proc.kill();
    }
  });

  it('should list 2 tools', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);
      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
      });

      const result = response.result as { tools: Array<{ name: string }> };
      expect(result.tools).toHaveLength(2);
      expect(result.tools.map(t => t.name)).toEqual(['toggle_tool_notifications', 'get_tool_notification_status']);
    } finally {
      proc.kill();
    }
  });

  it('toggle_tool_notifications enables notifications', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);
      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'toggle_tool_notifications',
          arguments: { group_id: 'test-group-1', enabled: true },
        },
      });

      const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('enabled');
    } finally {
      proc.kill();
    }
  });

  it('toggle_tool_notifications disables notifications', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);

      // Enable first
      await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'toggle_tool_notifications',
          arguments: { group_id: 'test-group-1', enabled: true },
        },
      });

      // Then disable
      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'toggle_tool_notifications',
          arguments: { group_id: 'test-group-1', enabled: false },
        },
      });

      const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('disabled');
    } finally {
      proc.kill();
    }
  });

  it('toggle_tool_notifications handles string "true" for enabled parameter', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);
      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'toggle_tool_notifications',
          arguments: { group_id: 'test-group-1', enabled: 'true' },
        },
      });

      const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('enabled');
    } finally {
      proc.kill();
    }
  });

  it('toggle_tool_notifications requires group_id parameter', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);
      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'toggle_tool_notifications',
          arguments: { enabled: true },
        },
      });

      const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('group_id');
    } finally {
      proc.kill();
    }
  });

  it('get_tool_notification_status returns enabled by default', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);
      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'get_tool_notification_status',
          arguments: { group_id: 'test-group-1' },
        },
      });

      const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('enabled');
    } finally {
      proc.kill();
    }
  });

  it('get_tool_notification_status returns enabled after toggle', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);

      // Enable notifications
      await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'toggle_tool_notifications',
          arguments: { group_id: 'test-group-1', enabled: true },
        },
      });

      // Check status
      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'get_tool_notification_status',
          arguments: { group_id: 'test-group-1' },
        },
      });

      const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('enabled');
    } finally {
      proc.kill();
    }
  });
});
