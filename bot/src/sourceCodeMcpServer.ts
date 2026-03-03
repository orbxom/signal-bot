import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';

const PROTOCOL_VERSION = '2025-03-26';

const SOURCE_ROOT = process.env.SOURCE_ROOT || '';

const SKIP_DIRS = new Set(['.git', 'node_modules', 'data', 'dist', '.claude']);
const MAX_FILE_SIZE = 50 * 1024; // 50KB
const MAX_SEARCH_MATCHES = 50;

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

const TOOLS = [
  {
    name: 'list_files',
    title: 'List Files',
    description: "List files in the bot's source repository. Returns file paths relative to the repository root.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'Directory path relative to repository root (default: root)',
        },
        recursive: {
          type: 'boolean',
          description: 'List files recursively (default: false)',
        },
      },
    },
  },
  {
    name: 'read_file',
    title: 'Read File',
    description:
      "Read the contents of a file from the bot's source repository. Path is relative to the repository root.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'File path relative to repository root',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'search_code',
    title: 'Search Code',
    description:
      "Search for a regex pattern across files in the bot's source repository. Returns matching lines with file paths and line numbers.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        pattern: {
          type: 'string',
          description: 'Regular expression pattern to search for',
        },
        path: {
          type: 'string',
          description: 'Subdirectory to search in (default: entire repository)',
        },
        filePattern: {
          type: 'string',
          description: 'Glob-like file extension filter, e.g. "*.ts" (default: all files)',
        },
      },
      required: ['pattern'],
    },
  },
];

function resolveSafePath(relativePath: string): string | null {
  if (!SOURCE_ROOT) return null;
  const resolved = path.resolve(SOURCE_ROOT, relativePath);
  // Prevent path traversal
  if (!resolved.startsWith(SOURCE_ROOT)) return null;
  return resolved;
}

function shouldSkip(name: string): boolean {
  return SKIP_DIRS.has(name) || name.startsWith('.');
}

function listFilesInDir(dirPath: string, recursive: boolean, rootPath: string): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (shouldSkip(entry.name)) continue;
    const fullPath = path.join(dirPath, entry.name);
    const relativePath = path.relative(rootPath, fullPath);

    if (entry.isFile()) {
      results.push(relativePath);
    } else if (entry.isDirectory()) {
      if (recursive) {
        results.push(...listFilesInDir(fullPath, true, rootPath));
      } else {
        results.push(`${relativePath}/`);
      }
    }
  }

  return results.sort();
}

function handleListFiles(args: Record<string, unknown>): ToolResult {
  if (!SOURCE_ROOT) {
    return { content: [{ type: 'text', text: 'SOURCE_ROOT not configured.' }], isError: true };
  }

  const relativePath = (args.path as string) || '.';
  const recursive = (args.recursive as boolean) || false;

  const resolved = resolveSafePath(relativePath);
  if (!resolved) {
    return { content: [{ type: 'text', text: 'Invalid path.' }], isError: true };
  }

  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return { content: [{ type: 'text', text: `Directory not found: ${relativePath}` }], isError: true };
  }

  const files = listFilesInDir(resolved, recursive, SOURCE_ROOT);
  if (files.length === 0) {
    return { content: [{ type: 'text', text: 'No files found.' }] };
  }

  return { content: [{ type: 'text', text: files.join('\n') }] };
}

function handleReadFile(args: Record<string, unknown>): ToolResult {
  if (!SOURCE_ROOT) {
    return { content: [{ type: 'text', text: 'SOURCE_ROOT not configured.' }], isError: true };
  }

  const filePath = args.path as string;
  if (!filePath || typeof filePath !== 'string') {
    return { content: [{ type: 'text', text: 'Missing required parameter: path' }], isError: true };
  }

  const resolved = resolveSafePath(filePath);
  if (!resolved) {
    return { content: [{ type: 'text', text: 'Invalid path.' }], isError: true };
  }

  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    return { content: [{ type: 'text', text: `File not found: ${filePath}` }], isError: true };
  }

  const stat = fs.statSync(resolved);
  if (stat.size > MAX_FILE_SIZE) {
    const content = fs.readFileSync(resolved, 'utf-8').substring(0, MAX_FILE_SIZE);
    return {
      content: [
        {
          type: 'text',
          text: `${content}\n\n[Truncated — file is ${stat.size} bytes, showing first ${MAX_FILE_SIZE} bytes]`,
        },
      ],
    };
  }

  const content = fs.readFileSync(resolved, 'utf-8');
  return { content: [{ type: 'text', text: content }] };
}

function searchInFile(
  filePath: string,
  regex: RegExp,
  rootPath: string,
): Array<{ file: string; line: number; text: string }> {
  const matches: Array<{ file: string; line: number; text: string }> = [];
  let content: string;
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_FILE_SIZE) return matches;
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return matches;
  }

  const relativePath = path.relative(rootPath, filePath);
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i])) {
      matches.push({ file: relativePath, line: i + 1, text: lines[i] });
    }
  }
  return matches;
}

function searchRecursive(
  dirPath: string,
  regex: RegExp,
  rootPath: string,
  extFilter: string | null,
  results: Array<{ file: string; line: number; text: string }>,
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (results.length >= MAX_SEARCH_MATCHES) return;
    if (shouldSkip(entry.name)) continue;
    const fullPath = path.join(dirPath, entry.name);

    if (entry.isFile()) {
      if (extFilter && !entry.name.endsWith(extFilter)) continue;
      const matches = searchInFile(fullPath, regex, rootPath);
      for (const m of matches) {
        if (results.length >= MAX_SEARCH_MATCHES) return;
        results.push(m);
      }
    } else if (entry.isDirectory()) {
      searchRecursive(fullPath, regex, rootPath, extFilter, results);
    }
  }
}

function handleSearchCode(args: Record<string, unknown>): ToolResult {
  if (!SOURCE_ROOT) {
    return { content: [{ type: 'text', text: 'SOURCE_ROOT not configured.' }], isError: true };
  }

  const pattern = args.pattern as string;
  if (!pattern || typeof pattern !== 'string') {
    return { content: [{ type: 'text', text: 'Missing required parameter: pattern' }], isError: true };
  }

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, 'i');
  } catch {
    return { content: [{ type: 'text', text: `Invalid regex pattern: ${pattern}` }], isError: true };
  }

  const relativePath = (args.path as string) || '.';
  const resolved = resolveSafePath(relativePath);
  if (!resolved) {
    return { content: [{ type: 'text', text: 'Invalid path.' }], isError: true };
  }

  // Parse filePattern like "*.ts" into just ".ts"
  let extFilter: string | null = null;
  if (args.filePattern && typeof args.filePattern === 'string') {
    const fp = args.filePattern;
    extFilter = fp.startsWith('*') ? fp.substring(1) : fp;
  }

  const results: Array<{ file: string; line: number; text: string }> = [];
  searchRecursive(resolved, regex, SOURCE_ROOT, extFilter, results);

  if (results.length === 0) {
    return { content: [{ type: 'text', text: `No matches found for pattern: ${pattern}` }] };
  }

  const lines = results.map(r => `${r.file}:${r.line}: ${r.text.trim()}`);
  let text = lines.join('\n');
  if (results.length >= MAX_SEARCH_MATCHES) {
    text += `\n\n[Results capped at ${MAX_SEARCH_MATCHES} matches]`;
  }

  return { content: [{ type: 'text', text }] };
}

function handleToolCall(name: string, args: Record<string, unknown>): ToolResult {
  switch (name) {
    case 'list_files':
      return handleListFiles(args);
    case 'read_file':
      return handleReadFile(args);
    case 'search_code':
      return handleSearchCode(args);
    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
}

function handleMessage(msg: { id?: number | string; method: string; params?: Record<string, unknown> }): object | null {
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'signal-bot-sourcecode', version: '1.0.0' },
        },
      };

    case 'notifications/initialized':
      return null;

    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id,
        result: { tools: TOOLS },
      };

    case 'tools/call': {
      const toolName = (params?.name as string) || '';
      const toolArgs = (params?.arguments as Record<string, unknown>) || {};
      const result = handleToolCall(toolName, toolArgs);
      return { jsonrpc: '2.0', id, result };
    }

    default:
      if (id !== undefined) {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        };
      }
      return null;
  }
}

function main() {
  if (!SOURCE_ROOT) {
    console.error('Warning: SOURCE_ROOT not set, source code tools will not function.');
  } else {
    console.error(`Source code MCP server started (root: ${SOURCE_ROOT})`);
  }

  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  rl.on('line', (line: string) => {
    if (!line.trim()) return;

    try {
      const msg = JSON.parse(line);
      const response = handleMessage(msg);
      if (response) {
        process.stdout.write(`${JSON.stringify(response)}\n`);
      }
    } catch (error) {
      console.error('Error processing message:', error);
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`,
      );
    }
  });

  rl.on('close', () => {
    process.exit(0);
  });
}

main();
