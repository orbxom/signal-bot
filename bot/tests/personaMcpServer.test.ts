import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeServer, sendAndReceive, spawnMcpServer as spawnServer } from './helpers/mcpTestHelpers';

describe('Persona MCP Server', () => {
  let testDir: string;
  let dbPath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'persona-mcp-test-'));
    dbPath = join(testDir, 'test.db');
  });

  afterEach(() => {
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  function spawnMcpServer(env: Record<string, string> = {}): ChildProcess {
    return spawnServer('personaMcpServer.ts', {
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
      expect(serverInfo.name).toBe('signal-bot-personas');
    } finally {
      proc.kill();
    }
  });

  it('should list 6 tools', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);
      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
      });

      const result = response.result as { tools: Array<{ name: string }> };
      expect(result.tools).toHaveLength(6);
      expect(result.tools.map(t => t.name)).toEqual([
        'create_persona',
        'get_persona',
        'list_personas',
        'update_persona',
        'delete_persona',
        'switch_persona',
      ]);
    } finally {
      proc.kill();
    }
  });

  it('should create a persona', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);
      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'create_persona',
          arguments: {
            name: 'Pirate Captain',
            description: 'Ye be a salty sea captain! Speak in pirate dialect.',
            tags: 'fun,pirate',
          },
        },
      });

      const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Pirate Captain');
      expect(result.content[0].text).toContain('created');
    } finally {
      proc.kill();
    }
  });

  it('should return error when creating persona with missing name', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);
      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'create_persona',
          arguments: {
            description: 'A description',
          },
        },
      });

      const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('name');
    } finally {
      proc.kill();
    }
  });

  it('should return error when creating persona with missing description', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);
      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'create_persona',
          arguments: {
            name: 'Test',
          },
        },
      });

      const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('description');
    } finally {
      proc.kill();
    }
  });

  it('should get a persona by name', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);

      // Create first
      await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'create_persona',
          arguments: { name: 'Zen Master', description: 'Speak with calm wisdom.', tags: 'calm' },
        },
      });

      // Get by name
      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'get_persona',
          arguments: { identifier: 'Zen Master' },
        },
      });

      const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Zen Master');
      expect(result.content[0].text).toContain('calm wisdom');
    } finally {
      proc.kill();
    }
  });

  it('should list personas including default', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);

      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'list_personas', arguments: {} },
      });

      const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Default Assistant');
    } finally {
      proc.kill();
    }
  });

  it('should update a persona', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);

      // Create
      const createResp = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'create_persona',
          arguments: { name: 'Pirate', description: 'Arr!', tags: '' },
        },
      });

      // Extract ID from response
      const createText = (createResp.result as { content: Array<{ text: string }> }).content[0].text;
      const idMatch = createText.match(/ID:\s*(\d+)/);
      expect(idMatch).not.toBeNull();
      const personaId = Number(idMatch?.[1]);

      // Update
      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'update_persona',
          arguments: {
            id: personaId,
            name: 'Captain Pirate',
            description: 'Avast, ye landlubbers!',
            tags: 'fun,pirate,captain',
          },
        },
      });

      const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Captain Pirate');
      expect(result.content[0].text).toContain('updated');
    } finally {
      proc.kill();
    }
  });

  it('should delete a persona', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);

      // Create
      const createResp = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'create_persona',
          arguments: { name: 'Temp', description: 'Temporary persona.', tags: '' },
        },
      });

      const createText = (createResp.result as { content: Array<{ text: string }> }).content[0].text;
      const idMatch = createText.match(/ID:\s*(\d+)/);
      const personaId = Number(idMatch?.[1]);

      // Delete
      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'delete_persona',
          arguments: { id: personaId },
        },
      });

      const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('deleted');
    } finally {
      proc.kill();
    }
  });

  it('should refuse to delete default persona', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);

      // The default persona has ID 1
      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'delete_persona',
          arguments: { id: 1 },
        },
      });

      const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Cannot delete');
    } finally {
      proc.kill();
    }
  });

  it('should switch persona for group', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);

      // Create a persona
      await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'create_persona',
          arguments: { name: 'Pirate', description: 'Arr, matey!', tags: '' },
        },
      });

      // Switch to it
      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'switch_persona',
          arguments: { identifier: 'Pirate' },
        },
      });

      const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Pirate');
      expect(result.content[0].text).toContain('switched');
    } finally {
      proc.kill();
    }
  });

  it('should switch to default with "default" keyword', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);

      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'switch_persona',
          arguments: { identifier: 'default' },
        },
      });

      const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Default Assistant');
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

  it('should mark active persona in list', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);

      // Create and switch
      await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'create_persona',
          arguments: { name: 'Pirate', description: 'Arr!', tags: '' },
        },
      });

      await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'switch_persona',
          arguments: { identifier: 'Pirate' },
        },
      });

      // List should mark Pirate as active
      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'list_personas', arguments: {} },
      });

      const result = response.result as { content: Array<{ text: string }> };
      expect(result.content[0].text).toContain('Pirate');
      expect(result.content[0].text).toContain('[ACTIVE]');
    } finally {
      proc.kill();
    }
  });

  it('should return error for non-existent persona on switch', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);

      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'switch_persona',
          arguments: { identifier: 'NonExistent' },
        },
      });

      const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not found');
    } finally {
      proc.kill();
    }
  });
});
