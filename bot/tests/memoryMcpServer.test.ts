// Test the memory MCP server by spawning it as a child process and
// communicating over the stdio JSON-RPC protocol.
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeServer, sendAndReceive, spawnMcpServer as spawnServer } from './helpers/mcpTestHelpers';

describe('Memory MCP Server', () => {
  let testDir: string;
  let dbPath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'memory-mcp-test-'));
    dbPath = join(testDir, 'test.db');
  });

  afterEach(() => {
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  function spawnMcpServer(env: Record<string, string> = {}): ChildProcess {
    return spawnServer('mcp/servers/memories.ts', {
      DB_PATH: dbPath,
      MCP_GROUP_ID: 'test-group-1',
      MCP_SENDER: '+61400000000',
      ...env,
    });
  }

  it('should respond to initialize request with server name', async () => {
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
      expect(serverInfo.name).toBe('signal-bot-memories');
    } finally {
      proc.kill();
    }
  });

  it('should list 4 tools', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);
      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
      });

      const result = response.result as { tools: Array<{ name: string }> };
      expect(result.tools).toHaveLength(4);
      expect(result.tools.map(t => t.name)).toEqual(['save_memory', 'get_memory', 'list_memories', 'delete_memory']);
    } finally {
      proc.kill();
    }
  });

  it('should save a memory successfully', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);
      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'save_memory',
          arguments: {
            topic: 'holiday plans',
            content: '- Going to Bali in March\n- Budget is $5000',
          },
        },
      });

      const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Saved memory "holiday plans"');
      expect(result.content[0].text).toContain('tokens used');
    } finally {
      proc.kill();
    }
  });

  it('should get a memory after saving one', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);

      // Save a memory first
      await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'save_memory',
          arguments: {
            topic: 'dietary restrictions',
            content: '- Alice is vegan\n- Bob has nut allergy',
          },
        },
      });

      // Get the memory
      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'get_memory',
          arguments: { topic: 'dietary restrictions' },
        },
      });

      const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('dietary restrictions');
      expect(result.content[0].text).toContain('Alice is vegan');
      expect(result.content[0].text).toContain('nut allergy');
    } finally {
      proc.kill();
    }
  });

  it('should list multiple memories', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);

      // Save two memories
      await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'save_memory',
          arguments: { topic: 'holiday plans', content: '- Bali in March' },
        },
      });

      await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'save_memory',
          arguments: { topic: 'dietary restrictions', content: '- No peanuts' },
        },
      });

      // List memories
      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'list_memories', arguments: {} },
      });

      const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('holiday plans');
      expect(result.content[0].text).toContain('dietary restrictions');
    } finally {
      proc.kill();
    }
  });

  it('should delete a memory successfully', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);

      // Save then delete
      await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'save_memory',
          arguments: { topic: 'old topic', content: 'Old content' },
        },
      });

      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'delete_memory',
          arguments: { topic: 'old topic' },
        },
      });

      const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Deleted memory "old topic"');
    } finally {
      proc.kill();
    }
  });

  it('should return "No memory found" for nonexistent topic', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);

      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'get_memory',
          arguments: { topic: 'nonexistent' },
        },
      });

      const result = response.result as { content: Array<{ text: string }> };
      expect(result.content[0].text).toContain('No memory found');
      expect(result.content[0].text).toContain('nonexistent');
    } finally {
      proc.kill();
    }
  });

  it('should return "No memories found" for empty group', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);

      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'list_memories', arguments: {} },
      });

      const result = response.result as { content: Array<{ text: string }> };
      expect(result.content[0].text).toContain('No memories found');
    } finally {
      proc.kill();
    }
  });

  it('should return error when topic is missing for save_memory', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);

      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'save_memory',
          arguments: { content: 'some content' },
        },
      });

      const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('topic');
    } finally {
      proc.kill();
    }
  });

  it('should return error when content is missing for save_memory', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);

      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'save_memory',
          arguments: { topic: 'a topic' },
        },
      });

      const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('content');
    } finally {
      proc.kill();
    }
  });
});
