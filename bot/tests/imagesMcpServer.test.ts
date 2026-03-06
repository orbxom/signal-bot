import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseConnection } from '../src/db';
import { AttachmentStore } from '../src/stores/attachmentStore';
import { initializeServer, sendAndReceive, spawnMcpServer as spawnServer } from './helpers/mcpTestHelpers';

describe('Images MCP Server', () => {
  let testDir: string;
  let dbPath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'images-mcp-test-'));
    dbPath = join(testDir, 'test.db');

    // Pre-populate the DB with test attachments
    const conn = new DatabaseConnection(dbPath);
    const store = new AttachmentStore(conn);
    store.save({
      id: 'img-123',
      groupId: 'test-group-1',
      sender: '+61400111222',
      contentType: 'image/jpeg',
      size: 1234,
      filename: 'photo.jpg',
      data: Buffer.from('fake jpeg data'),
      timestamp: Date.now(),
    });
    store.save({
      id: 'img-456',
      groupId: 'test-group-1',
      sender: '+61400111222',
      contentType: 'image/png',
      size: 5678,
      filename: null,
      data: Buffer.from('fake png data'),
      timestamp: Date.now(),
    });
    conn.close();
  });

  afterEach(() => {
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  function spawnMcpServer(env: Record<string, string> = {}): ChildProcess {
    return spawnServer('mcp/servers/images.ts', {
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
      const serverInfo = result.serverInfo as Record<string, string>;
      expect(serverInfo.name).toBe('signal-bot-images');
    } finally {
      proc.kill();
    }
  });

  it('should list view_image tool', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);
      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
      });

      const result = response.result as { tools: Array<{ name: string }> };
      expect(result.tools).toHaveLength(1);
      expect(result.tools[0].name).toBe('view_image');
    } finally {
      proc.kill();
    }
  });

  it('should return image content block for valid attachment', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);
      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'view_image', arguments: { attachmentId: 'img-123' } },
      });

      const result = response.result as { content: Array<Record<string, unknown>>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      expect(result.content).toHaveLength(2);
      expect(result.content[0]).toEqual({
        type: 'image',
        data: Buffer.from('fake jpeg data').toString('base64'),
        mimeType: 'image/jpeg',
      });
      expect(result.content[1]).toEqual(
        expect.objectContaining({ type: 'text' }),
      );
      expect((result.content[1] as { text: string }).text).toContain('photo.jpg');
      expect((result.content[1] as { text: string }).text).toContain('image/jpeg');
    } finally {
      proc.kill();
    }
  });

  it('should handle attachment without filename', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);
      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'view_image', arguments: { attachmentId: 'img-456' } },
      });

      const result = response.result as { content: Array<Record<string, unknown>>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      expect(result.content).toHaveLength(2);
      expect(result.content[0]).toEqual({
        type: 'image',
        data: Buffer.from('fake png data').toString('base64'),
        mimeType: 'image/png',
      });
      // When no filename, should fall back to attachment ID
      expect((result.content[1] as { text: string }).text).toContain('img-456');
    } finally {
      proc.kill();
    }
  });

  it('should return error for non-existent attachment', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);
      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'view_image', arguments: { attachmentId: 'nonexistent' } },
      });

      const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Attachment not found');
    } finally {
      proc.kill();
    }
  });

  it('should require attachmentId parameter', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);
      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { name: 'view_image', arguments: {} },
      });

      const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('attachmentId');
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
        id: 7,
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
