import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Storage } from '../src/storage';
import { initializeServer, sendAndReceive, spawnMcpServer as spawnServer } from './helpers/mcpTestHelpers';

describe('Message History MCP Server', () => {
  let testDir: string;
  let dbPath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'mcp-history-test-'));
    dbPath = join(testDir, 'test.db');
  });

  afterEach(() => {
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  function spawnMcpServer(env: Record<string, string> = {}): ChildProcess {
    return spawnServer('mcp/servers/messageHistory.ts', {
      DB_PATH: dbPath,
      MCP_GROUP_ID: 'test-group-1',
      TZ: 'Australia/Sydney',
      ...env,
    });
  }

  function seedMessages(): void {
    const storage = new Storage(dbPath);
    try {
      // Messages at known timestamps for predictable date range queries
      // 2024-01-15 10:00 UTC
      storage.addMessage({
        groupId: 'test-group-1',
        sender: '+61400000001',
        content: 'Has anyone seen the new pizza place downtown?',
        timestamp: 1705312800000,
        isBot: false,
      });
      // 2024-01-15 11:00 UTC
      storage.addMessage({
        groupId: 'test-group-1',
        sender: '+61400000002',
        content: 'Yes! The pizza there is amazing.',
        timestamp: 1705316400000,
        isBot: false,
      });
      // 2024-01-16 09:00 UTC
      storage.addMessage({
        groupId: 'test-group-1',
        sender: '+61400000001',
        content: 'What time is the meeting tomorrow?',
        timestamp: 1705395600000,
        isBot: false,
      });
      // 2024-01-16 09:30 UTC
      storage.addMessage({
        groupId: 'test-group-1',
        sender: '+61400000003',
        content: 'The meeting is at 2pm.',
        timestamp: 1705397400000,
        isBot: false,
      });
      // Message in a different group (should not appear in results)
      storage.addMessage({
        groupId: 'other-group',
        sender: '+61400000001',
        content: 'This is pizza in another group.',
        timestamp: 1705316400000,
        isBot: false,
      });
    } finally {
      storage.close();
    }
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
      expect(serverInfo.name).toBe('signal-bot-message-history');
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
      expect(result.tools.map(t => t.name)).toEqual(['search_messages', 'get_messages_by_date']);
    } finally {
      proc.kill();
    }
  });

  describe('search_messages', () => {
    it('should find messages matching a keyword', async () => {
      seedMessages();
      const proc = spawnMcpServer();
      try {
        await initializeServer(proc);
        const response = await sendAndReceive(proc, {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'search_messages', arguments: { keyword: 'pizza' } },
        });

        const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
        expect(result.isError).toBeFalsy();
        expect(result.content[0].text).toContain('Found 2 message(s)');
        expect(result.content[0].text).toContain('pizza place downtown');
        expect(result.content[0].text).toContain('pizza there is amazing');
        // Should NOT include the message from other-group
        expect(result.content[0].text).not.toContain('another group');
      } finally {
        proc.kill();
      }
    });

    it('should filter by sender', async () => {
      seedMessages();
      const proc = spawnMcpServer();
      try {
        await initializeServer(proc);
        const response = await sendAndReceive(proc, {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'search_messages',
            arguments: { keyword: 'pizza', sender: '+61400000002' },
          },
        });

        const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
        expect(result.isError).toBeFalsy();
        expect(result.content[0].text).toContain('Found 1 message(s)');
        expect(result.content[0].text).toContain('+61400000002');
        expect(result.content[0].text).toContain('pizza there is amazing');
      } finally {
        proc.kill();
      }
    });

    it('should filter by date range', async () => {
      seedMessages();
      const proc = spawnMcpServer();
      try {
        await initializeServer(proc);
        // Search for "meeting" only on Jan 16
        const response = await sendAndReceive(proc, {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'search_messages',
            arguments: {
              keyword: 'meeting',
              startDate: '2024-01-16T00:00:00Z',
              endDate: '2024-01-16T23:59:59Z',
            },
          },
        });

        const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
        expect(result.isError).toBeFalsy();
        expect(result.content[0].text).toContain('Found 2 message(s)');
        expect(result.content[0].text).toContain('meeting tomorrow');
        expect(result.content[0].text).toContain('meeting is at 2pm');
      } finally {
        proc.kill();
      }
    });

    it('should return empty results for non-matching keyword', async () => {
      seedMessages();
      const proc = spawnMcpServer();
      try {
        await initializeServer(proc);
        const response = await sendAndReceive(proc, {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'search_messages', arguments: { keyword: 'xyznonexistent' } },
        });

        const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
        expect(result.isError).toBeFalsy();
        expect(result.content[0].text).toBe('No messages found.');
      } finally {
        proc.kill();
      }
    });

    it('should return error for missing keyword', async () => {
      const proc = spawnMcpServer();
      try {
        await initializeServer(proc);
        const response = await sendAndReceive(proc, {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'search_messages', arguments: {} },
        });

        const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Missing or invalid keyword');
      } finally {
        proc.kill();
      }
    });
  });

  describe('get_messages_by_date', () => {
    it('should retrieve messages in a date range', async () => {
      seedMessages();
      const proc = spawnMcpServer();
      try {
        await initializeServer(proc);
        // Get only Jan 15 messages
        const response = await sendAndReceive(proc, {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'get_messages_by_date',
            arguments: {
              startDate: '2024-01-15T00:00:00Z',
              endDate: '2024-01-15T23:59:59Z',
            },
          },
        });

        const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
        expect(result.isError).toBeFalsy();
        expect(result.content[0].text).toContain('Found 2 message(s)');
        expect(result.content[0].text).toContain('pizza place downtown');
        expect(result.content[0].text).toContain('pizza there is amazing');
        // Should not include Jan 16 messages
        expect(result.content[0].text).not.toContain('meeting');
      } finally {
        proc.kill();
      }
    });

    it('should return empty results for range with no messages', async () => {
      seedMessages();
      const proc = spawnMcpServer();
      try {
        await initializeServer(proc);
        const response = await sendAndReceive(proc, {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'get_messages_by_date',
            arguments: {
              startDate: '2023-01-01T00:00:00Z',
              endDate: '2023-01-02T00:00:00Z',
            },
          },
        });

        const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
        expect(result.isError).toBeFalsy();
        expect(result.content[0].text).toBe('No messages found.');
      } finally {
        proc.kill();
      }
    });

    it('should return error for missing startDate', async () => {
      const proc = spawnMcpServer();
      try {
        await initializeServer(proc);
        const response = await sendAndReceive(proc, {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'get_messages_by_date', arguments: {} },
        });

        const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Missing or invalid startDate');
      } finally {
        proc.kill();
      }
    });

    it('should default endDate to now when not provided', async () => {
      seedMessages();
      const proc = spawnMcpServer();
      try {
        await initializeServer(proc);
        // Get all messages from Jan 16 onward (no endDate)
        const response = await sendAndReceive(proc, {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'get_messages_by_date',
            arguments: { startDate: '2024-01-16T00:00:00Z' },
          },
        });

        const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
        expect(result.isError).toBeFalsy();
        expect(result.content[0].text).toContain('Found 2 message(s)');
        expect(result.content[0].text).toContain('meeting tomorrow');
        expect(result.content[0].text).toContain('meeting is at 2pm');
      } finally {
        proc.kill();
      }
    });
  });

  it('should format timestamps in configured timezone', async () => {
    seedMessages();
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);
      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'search_messages', arguments: { keyword: 'pizza place' } },
      });

      const result = response.result as { content: Array<{ text: string }> };
      // 2024-01-15 10:00 UTC = 2024-01-15 21:00 AEDT (Australia/Sydney)
      // ISO-like format: YYYY-MM-DD HH:MM (same as conversation context timestamps)
      expect(result.content[0].text).toContain('2024-01-15 21:00');
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
