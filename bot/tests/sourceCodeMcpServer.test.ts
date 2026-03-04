import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeServer, sendAndReceive, spawnMcpServer as spawnServer } from './helpers/mcpTestHelpers';

describe('Source Code MCP Server', () => {
  let proc: ChildProcess | null = null;
  let tempDir: string;

  beforeEach(() => {
    // Create a temp directory with known files to use as SOURCE_ROOT
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcecode-test-'));
    fs.mkdirSync(path.join(tempDir, 'src'));
    fs.writeFileSync(path.join(tempDir, 'src', 'index.ts'), 'console.log("hello world");\n');
    fs.writeFileSync(
      path.join(tempDir, 'src', 'utils.ts'),
      'export function add(a: number, b: number) { return a + b; }\n',
    );
    fs.writeFileSync(path.join(tempDir, 'package.json'), '{"name": "test-project"}\n');
    fs.mkdirSync(path.join(tempDir, 'src', 'nested'));
    fs.writeFileSync(path.join(tempDir, 'src', 'nested', 'deep.ts'), 'export const x = 1;\n');
    // Create a directory that should be skipped
    fs.mkdirSync(path.join(tempDir, 'node_modules'));
    fs.writeFileSync(path.join(tempDir, 'node_modules', 'secret.js'), 'secret');
    fs.mkdirSync(path.join(tempDir, '.git'));
    fs.writeFileSync(path.join(tempDir, '.git', 'config'), 'gitconfig');
  });

  afterEach(() => {
    if (proc) {
      proc.kill();
      proc = null;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function spawnMcpServer(sourceRoot?: string): ChildProcess {
    proc = spawnServer('mcp/servers/sourceCode.ts', { SOURCE_ROOT: sourceRoot ?? tempDir });
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
    expect(serverInfo.name).toBe('signal-bot-sourcecode');
  });

  it('should list 3 tools', async () => {
    const server = spawnMcpServer();
    await initializeServer(server);
    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });

    const result = response.result as { tools: Array<{ name: string }> };
    expect(result.tools).toHaveLength(3);
    expect(result.tools.map(t => t.name)).toEqual(['list_files', 'read_file', 'search_code']);
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

  // list_files tests

  it('should list files in root directory', async () => {
    const server = spawnMcpServer();
    await initializeServer(server);
    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'list_files', arguments: {} },
    });

    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain('package.json');
    expect(text).toContain('src/');
    // Should skip .git and node_modules
    expect(text).not.toContain('node_modules');
    expect(text).not.toContain('.git');
  });

  it('should list files recursively', async () => {
    const server = spawnMcpServer();
    await initializeServer(server);
    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'list_files', arguments: { recursive: true } },
    });

    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain('src/index.ts');
    expect(text).toContain('src/utils.ts');
    expect(text).toContain('src/nested/deep.ts');
    expect(text).toContain('package.json');
  });

  it('should list files in subdirectory', async () => {
    const server = spawnMcpServer();
    await initializeServer(server);
    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'list_files', arguments: { path: 'src' } },
    });

    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain('index.ts');
    // Should not include package.json (that's in root)
    expect(text).not.toContain('package.json');
  });

  it('should return error for nonexistent directory', async () => {
    const server = spawnMcpServer();
    await initializeServer(server);
    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'list_files', arguments: { path: 'nonexistent' } },
    });

    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });

  // read_file tests

  it('should read a file', async () => {
    const server = spawnMcpServer();
    await initializeServer(server);
    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'read_file', arguments: { path: 'src/index.ts' } },
    });

    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('console.log("hello world")');
  });

  it('should reject path traversal attempts', async () => {
    const server = spawnMcpServer();
    await initializeServer(server);
    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'read_file', arguments: { path: '../../../etc/passwd' } },
    });

    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid path');
  });

  it('should return error for nonexistent file', async () => {
    const server = spawnMcpServer();
    await initializeServer(server);
    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: { name: 'read_file', arguments: { path: 'does-not-exist.ts' } },
    });

    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });

  it('should return error when path is missing', async () => {
    const server = spawnMcpServer();
    await initializeServer(server);
    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: { name: 'read_file', arguments: {} },
    });

    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Missing');
  });

  // search_code tests

  it('should search for a pattern', async () => {
    const server = spawnMcpServer();
    await initializeServer(server);
    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 13,
      method: 'tools/call',
      params: { name: 'search_code', arguments: { pattern: 'hello' } },
    });

    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('src/index.ts');
    expect(result.content[0].text).toContain('hello world');
  });

  it('should filter by file pattern', async () => {
    const server = spawnMcpServer();
    await initializeServer(server);
    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 14,
      method: 'tools/call',
      params: { name: 'search_code', arguments: { pattern: 'name', filePattern: '*.json' } },
    });

    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain('package.json');
    // Should not match .ts files
    expect(text).not.toContain('.ts');
  });

  it('should search within a subdirectory', async () => {
    const server = spawnMcpServer();
    await initializeServer(server);
    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 15,
      method: 'tools/call',
      params: { name: 'search_code', arguments: { pattern: 'export', path: 'src/nested' } },
    });

    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain('nested/deep.ts');
    // Should not include files outside the subdirectory
    expect(text).not.toContain('utils.ts');
  });

  it('should return no matches message when nothing found', async () => {
    const server = spawnMcpServer();
    await initializeServer(server);
    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 16,
      method: 'tools/call',
      params: { name: 'search_code', arguments: { pattern: 'zzzznotfound' } },
    });

    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('No matches found');
  });

  it('should return error for invalid regex', async () => {
    const server = spawnMcpServer();
    await initializeServer(server);
    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 17,
      method: 'tools/call',
      params: { name: 'search_code', arguments: { pattern: '[invalid' } },
    });

    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid regex');
  });

  it('should reject path traversal in search', async () => {
    const server = spawnMcpServer();
    await initializeServer(server);
    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 18,
      method: 'tools/call',
      params: { name: 'search_code', arguments: { pattern: 'root', path: '../../..' } },
    });

    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid path');
  });

  // SOURCE_ROOT not configured

  it('should return error when SOURCE_ROOT is empty', async () => {
    const server = spawnMcpServer('');
    await initializeServer(server);
    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 19,
      method: 'tools/call',
      params: { name: 'list_files', arguments: {} },
    });

    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('SOURCE_ROOT');
  });
});
