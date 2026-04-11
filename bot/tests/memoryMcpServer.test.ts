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

  it('should list 8 tools', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);
      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
      });

      const result = response.result as { tools: Array<{ name: string }> };
      expect(result.tools).toHaveLength(8);
      expect(result.tools.map(t => t.name)).toEqual([
        'save_memory',
        'update_memory',
        'get_memory',
        'search_memories',
        'list_types',
        'list_tags',
        'delete_memory',
        'manage_tags',
      ]);
    } finally {
      proc.kill();
    }
  });

  it('should save and get a memory with tags', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);

      // Save a memory
      const saveResponse = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'save_memory',
          arguments: {
            title: 'holiday plans',
            type: 'event',
            description: 'Family holiday planning',
            content: '- Going to Bali in March\n- Budget is $5000',
            tags: ['holiday', 'travel'],
          },
        },
      });

      const saveResult = saveResponse.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(saveResult.isError).toBeFalsy();
      expect(saveResult.content[0].text).toContain('holiday plans');
      expect(saveResult.content[0].text).toContain('event');

      // Get by ID — extract ID from response
      const text = saveResult.content[0].text;
      const idMatch = text.match(/#(\d+)/);
      expect(idMatch).toBeTruthy();
      const id = Number(idMatch?.[1]);

      const getResponse = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'get_memory',
          arguments: { id },
        },
      });

      const getResult = getResponse.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(getResult.isError).toBeFalsy();
      expect(getResult.content[0].text).toContain('holiday plans');
      expect(getResult.content[0].text).toContain('event');
      expect(getResult.content[0].text).toContain('holiday');
      expect(getResult.content[0].text).toContain('travel');
    } finally {
      proc.kill();
    }
  });

  it('should search memories by keyword', async () => {
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
          arguments: { title: 'holiday plans', type: 'event', content: 'Bali in March' },
        },
      });

      await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'save_memory',
          arguments: { title: 'dietary restrictions', type: 'preference', content: 'Alice is vegan' },
        },
      });

      // Search for "Bali"
      const searchResponse = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'search_memories',
          arguments: { keyword: 'Bali' },
        },
      });

      const result = searchResponse.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('holiday plans');
      expect(result.content[0].text).not.toContain('dietary restrictions');
    } finally {
      proc.kill();
    }
  });

  it('should list types and tags', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);

      // Save memories with different types and tags
      await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'save_memory',
          arguments: { title: 'holiday plans', type: 'event', tags: ['travel', 'family'] },
        },
      });

      await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'save_memory',
          arguments: { title: 'dietary restrictions', type: 'preference', tags: ['food'] },
        },
      });

      // List types
      const typesResponse = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'list_types', arguments: {} },
      });

      const typesResult = typesResponse.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(typesResult.isError).toBeFalsy();
      expect(typesResult.content[0].text).toContain('event');
      expect(typesResult.content[0].text).toContain('preference');

      // List tags
      const tagsResponse = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { name: 'list_tags', arguments: {} },
      });

      const tagsResult = tagsResponse.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(tagsResult.isError).toBeFalsy();
      expect(tagsResult.content[0].text).toContain('travel');
      expect(tagsResult.content[0].text).toContain('family');
      expect(tagsResult.content[0].text).toContain('food');
    } finally {
      proc.kill();
    }
  });

  it('should delete a memory by id', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);

      // Save a memory
      const saveResponse = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'save_memory',
          arguments: { title: 'old topic', type: 'note', content: 'Old content' },
        },
      });

      const saveResult = saveResponse.result as { content: Array<{ text: string }> };
      const idMatch = saveResult.content[0].text.match(/#(\d+)/);
      const id = Number(idMatch?.[1]);

      // Delete it
      const deleteResponse = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'delete_memory',
          arguments: { id },
        },
      });

      const deleteResult = deleteResponse.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(deleteResult.isError).toBeFalsy();
      expect(deleteResult.content[0].text).toContain('Deleted');

      // Verify it's gone
      const getResponse = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'get_memory', arguments: { id } },
      });

      const getResult = getResponse.result as { content: Array<{ text: string }> };
      expect(getResult.content[0].text).toContain('not found');
    } finally {
      proc.kill();
    }
  });

  it('should update a memory', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);

      // Save a memory
      const saveResponse = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'save_memory',
          arguments: { title: 'original title', type: 'note', content: 'original content' },
        },
      });

      const saveResult = saveResponse.result as { content: Array<{ text: string }> };
      const idMatch = saveResult.content[0].text.match(/#(\d+)/);
      const id = Number(idMatch?.[1]);

      // Update it
      const updateResponse = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'update_memory',
          arguments: { id, title: 'updated title', content: 'updated content' },
        },
      });

      const updateResult = updateResponse.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(updateResult.isError).toBeFalsy();
      expect(updateResult.content[0].text).toContain('updated title');
    } finally {
      proc.kill();
    }
  });

  it('should manage tags (add and remove)', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);

      // Save a memory with initial tags
      const saveResponse = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'save_memory',
          arguments: { title: 'tagged memory', type: 'note', tags: ['alpha', 'beta'] },
        },
      });

      const saveResult = saveResponse.result as { content: Array<{ text: string }> };
      const idMatch = saveResult.content[0].text.match(/#(\d+)/);
      const id = Number(idMatch?.[1]);

      // Manage tags: add 'gamma', remove 'alpha'
      const manageResponse = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'manage_tags',
          arguments: { id, add: ['gamma'], remove: ['alpha'] },
        },
      });

      const manageResult = manageResponse.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(manageResult.isError).toBeFalsy();
      expect(manageResult.content[0].text).toContain('gamma');
      expect(manageResult.content[0].text).toContain('beta');
      expect(manageResult.content[0].text).not.toContain('alpha');
    } finally {
      proc.kill();
    }
  });

  it('should return not found for missing memory id in get_memory', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);

      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'get_memory',
          arguments: { id: 99999 },
        },
      });

      const result = response.result as { content: Array<{ text: string }> };
      expect(result.content[0].text).toContain('not found');
    } finally {
      proc.kill();
    }
  });

  it('should return error when required args are missing for save_memory', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);

      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'save_memory',
          arguments: { title: 'no type here' },
        },
      });

      const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('type');
    } finally {
      proc.kill();
    }
  });
});
