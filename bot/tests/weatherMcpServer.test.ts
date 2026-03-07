import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { initializeServer, sendAndReceive, spawnMcpServer as spawnServer } from './helpers/mcpTestHelpers';

describe('Weather MCP Server', () => {
  let proc: ChildProcess | null = null;

  afterEach(() => {
    if (proc) {
      proc.kill();
      proc = null;
    }
  });

  function spawnMcpServer(): ChildProcess {
    proc = spawnServer('mcp/servers/weather.ts', { TZ: 'Australia/Sydney' });
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
    expect(result.capabilities).toEqual({ tools: {} });
    const serverInfo = result.serverInfo as Record<string, string>;
    expect(serverInfo.name).toBe('signal-bot-weather');
  });

  it('should list 5 tools', async () => {
    const server = spawnMcpServer();
    await initializeServer(server);
    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });

    const result = response.result as { tools: Array<{ name: string }> };
    expect(result.tools).toHaveLength(5);
    expect(result.tools.map(t => t.name)).toEqual([
      'search_location',
      'get_observations',
      'get_forecast',
      'get_warnings',
      'get_radar_image',
    ]);
  });

  it('should return error for unknown tool', async () => {
    const server = spawnMcpServer();
    await initializeServer(server);
    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'nonexistent_tool', arguments: {} },
    });

    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown tool');
  });

  it('should return error for unknown method', async () => {
    const server = spawnMcpServer();
    await initializeServer(server);
    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 4,
      method: 'unknown/method',
    });

    expect(response.error).toBeDefined();
    const error = response.error as { code: number; message: string };
    expect(error.code).toBe(-32601);
  });

  it('should search for a location by name', async () => {
    const server = spawnMcpServer();
    await initializeServer(server);
    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'search_location', arguments: { query: 'Sydney' } },
    });

    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('geohash');
  });

  it('should reject short search queries', async () => {
    const server = spawnMcpServer();
    await initializeServer(server);
    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'search_location', arguments: { query: 'ab' } },
    });

    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('at least 3');
  });

  it('should get observations for a valid geohash', async () => {
    const server = spawnMcpServer();
    await initializeServer(server);

    // r3gx2s is Sydney area (6-char geohash)
    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'get_observations', arguments: { geohash: 'r3gx2s' } },
    });

    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('Temperature');
  });

  it('should handle 7-char geohash for observations by trimming', async () => {
    const server = spawnMcpServer();
    await initializeServer(server);

    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'get_observations', arguments: { geohash: 'r3gx2sp' } },
    });

    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('Temperature');
  });

  it('should reject invalid geohash for observations', async () => {
    const server = spawnMcpServer();
    await initializeServer(server);

    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'get_observations', arguments: { geohash: 'ab' } },
    });

    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('invalid geohash');
  });

  it('should get daily forecast', async () => {
    const server = spawnMcpServer();
    await initializeServer(server);

    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'get_forecast', arguments: { geohash: 'r3gx2s' } },
    });

    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('forecast');
  });

  it('should get warnings or report none', async () => {
    const server = spawnMcpServer();
    await initializeServer(server);

    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: { name: 'get_warnings', arguments: { geohash: 'r3gx2s' } },
    });

    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeFalsy();
    // Either has warnings or reports none — both are valid
    const text = result.content[0].text;
    expect(text.includes('warning') || text.includes('No active')).toBe(true);
  });

  it('should fetch radar image for a valid location', async () => {
    const server = spawnMcpServer();
    await initializeServer(server);

    const response = await sendAndReceive(
      server,
      {
        jsonrpc: '2.0',
        id: 12,
        method: 'tools/call',
        params: { name: 'get_radar_image', arguments: { location: 'Sydney' } },
      },
      30000,
    );

    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;

    // Should return a file path
    expect(text).toContain('radar-IDR');
    expect(text).toContain('.gif');

    // Extract file path and verify the file exists with GIF magic bytes
    const match = text.match(/(\/\S+\.gif)/);
    expect(match).not.toBeNull();
    const filePath = match?.[1];
    expect(fs.existsSync(filePath)).toBe(true);

    const buffer = fs.readFileSync(filePath);
    const magic = buffer.subarray(0, 6).toString('ascii');
    expect(magic === 'GIF89a' || magic === 'GIF87a').toBe(true);

    // Clean up
    fs.unlinkSync(filePath);
  }, 30000);

  it('should return error with station list for unknown location', async () => {
    const server = spawnMcpServer();
    await initializeServer(server);

    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 13,
      method: 'tools/call',
      params: { name: 'get_radar_image', arguments: { location: 'Narnia' } },
    });

    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain('Unknown location');
    // Error should list available stations
    expect(text).toContain('Sydney');
    expect(text).toContain('Melbourne');
    expect(text).toContain('Brisbane');
  });

  it('should handle case-insensitive location lookup', async () => {
    const server = spawnMcpServer();
    await initializeServer(server);

    const response = await sendAndReceive(
      server,
      {
        jsonrpc: '2.0',
        id: 14,
        method: 'tools/call',
        params: { name: 'get_radar_image', arguments: { location: 'sydney' } },
      },
      30000,
    );

    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain('.gif');

    // Clean up temp file
    const match = text.match(/(\/\S+\.gif)/);
    if (match) fs.unlinkSync(match[1]);
  }, 30000);

  it('should return error when location parameter is missing', async () => {
    const server = spawnMcpServer();
    await initializeServer(server);

    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 15,
      method: 'tools/call',
      params: { name: 'get_radar_image', arguments: {} },
    });

    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('location');
  });

  it('should fetch radar image with explicit range parameter', async () => {
    const server = spawnMcpServer();
    await initializeServer(server);

    const response = await sendAndReceive(
      server,
      {
        jsonrpc: '2.0',
        id: 16,
        method: 'tools/call',
        params: { name: 'get_radar_image', arguments: { location: 'Sydney', range: '256km' } },
      },
      30000,
    );

    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    // Product ID should use suffix '2' for 256km (IDR712)
    expect(text).toContain('IDR712');
    expect(text).toContain('256km');

    // Clean up temp file
    const match = text.match(/(\/\S+\.gif)/);
    if (match) fs.unlinkSync(match[1]);
  }, 30000);

  it('should return error for invalid range parameter', async () => {
    const server = spawnMcpServer();
    await initializeServer(server);

    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 17,
      method: 'tools/call',
      params: { name: 'get_radar_image', arguments: { location: 'Sydney', range: '999km' } },
    });

    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid range');
    expect(result.content[0].text).toContain('128km');
  });
});
