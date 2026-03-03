// Test the dossier MCP server by spawning it as a child process and
// communicating over the stdio JSON-RPC protocol, exactly like reminderMcpServer.test.ts.
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeServer, sendAndReceive, spawnMcpServer as spawnServer } from './helpers/mcpTestHelpers';

describe('Dossier MCP Server', () => {
  let testDir: string;
  let dbPath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'dossier-mcp-test-'));
    dbPath = join(testDir, 'test.db');
  });

  afterEach(() => {
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  function spawnMcpServer(env: Record<string, string> = {}): ChildProcess {
    return spawnServer('dossierMcpServer.ts', {
      DB_PATH: dbPath,
      MCP_GROUP_ID: 'test-group-1',
      MCP_SENDER: '+61400000000',
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
      expect(serverInfo.name).toBe('signal-bot-dossiers');
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
      expect(result.tools.map(t => t.name)).toEqual(['update_dossier', 'get_dossier', 'list_dossiers']);
    } finally {
      proc.kill();
    }
  });

  it('should update a dossier', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);
      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'update_dossier',
          arguments: {
            personId: '+61400111111',
            displayName: 'Alice',
            notes: '- Likes hiking\n- Has a dog named Rex',
          },
        },
      });

      const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Updated dossier for Alice');
      expect(result.content[0].text).toContain('+61400111111');
      expect(result.content[0].text).toContain('tokens used');
    } finally {
      proc.kill();
    }
  });

  it('should get a dossier after creating one', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);

      // Create a dossier first
      await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'update_dossier',
          arguments: {
            personId: '+61400111111',
            displayName: 'Bob',
            notes: '- Works at the bakery\n- Morning person',
          },
        },
      });

      // Get the dossier
      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'get_dossier',
          arguments: { personId: '+61400111111' },
        },
      });

      const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Bob');
      expect(result.content[0].text).toContain('+61400111111');
      expect(result.content[0].text).toContain('bakery');
      expect(result.content[0].text).toContain('Morning person');
    } finally {
      proc.kill();
    }
  });

  it('should list dossiers', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);

      // Create two dossiers
      await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'update_dossier',
          arguments: { personId: '+61400111111', displayName: 'Alice', notes: '- Likes cats' },
        },
      });

      await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'update_dossier',
          arguments: { personId: '+61400222222', displayName: 'Bob', notes: '- Likes dogs' },
        },
      });

      // List dossiers
      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'list_dossiers', arguments: {} },
      });

      const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Alice');
      expect(result.content[0].text).toContain('Bob');
      expect(result.content[0].text).toContain('+61400111111');
      expect(result.content[0].text).toContain('+61400222222');
    } finally {
      proc.kill();
    }
  });

  it('should return "No dossier found" for nonexistent person', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);

      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'get_dossier',
          arguments: { personId: '+61400999999' },
        },
      });

      const result = response.result as { content: Array<{ text: string }> };
      expect(result.content[0].text).toContain('No dossier found');
      expect(result.content[0].text).toContain('+61400999999');
    } finally {
      proc.kill();
    }
  });

  it('should return "No dossiers found" for empty group', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);

      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'list_dossiers', arguments: {} },
      });

      const result = response.result as { content: Array<{ text: string }> };
      expect(result.content[0].text).toContain('No dossiers found');
    } finally {
      proc.kill();
    }
  });

  it('should return error when personId is missing', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);

      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'update_dossier',
          arguments: { displayName: 'Alice', notes: 'some notes' },
        },
      });

      const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('personId');
    } finally {
      proc.kill();
    }
  });

  it('should return error when displayName is missing', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);

      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'update_dossier',
          arguments: { personId: '+61400111111', notes: 'some notes' },
        },
      });

      const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('displayName');
    } finally {
      proc.kill();
    }
  });

  it('should return error when notes exceed token limit', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);

      // 4001 characters = ceil(4001/4) = 1001 tokens, which exceeds the 1000 token limit
      const longNotes = 'x'.repeat(4001);
      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'update_dossier',
          arguments: { personId: '+61400111111', displayName: 'Alice', notes: longNotes },
        },
      });

      const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('token limit');
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

  it('should return error for unknown method', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);

      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 99,
        method: 'something/bogus',
      });

      expect(response.error).toBeDefined();
      const error = response.error as { code: number; message: string };
      expect(error.code).toBe(-32601);
      expect(error.message).toContain('Method not found');
    } finally {
      proc.kill();
    }
  });

  it('should update existing dossier (upsert)', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);

      // Create initial dossier
      await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'update_dossier',
          arguments: { personId: '+61400111111', displayName: 'Alice', notes: '- Original note' },
        },
      });

      // Update the same person with new info
      await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'update_dossier',
          arguments: {
            personId: '+61400111111',
            displayName: 'Alice W.',
            notes: '- Original note\n- New note added',
          },
        },
      });

      // Get the dossier and verify it has the latest data
      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'get_dossier',
          arguments: { personId: '+61400111111' },
        },
      });

      const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Alice W.');
      expect(result.content[0].text).toContain('New note added');
      // Should not still show old displayName
      expect(result.content[0].text).not.toContain('\nAlice\n');
    } finally {
      proc.kill();
    }
  });
});
