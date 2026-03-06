import * as fs from 'node:fs';
import * as path from 'node:path';
import { error as errorResult, ok } from '../result';
import { runServer } from '../runServer';
import type { McpServerDefinition } from '../types';
import { requireString } from '../validate';

const SKIP_DIRS = new Set(['.git', 'node_modules', 'data', 'dist', '.claude']);
const MAX_FILE_SIZE = 50 * 1024; // 50KB
const MAX_SEARCH_MATCHES = 50;

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

let sourceRoot: string;

function resolveSafePath(relativePath: string): string | null {
  if (!sourceRoot) return null;
  const resolved = path.resolve(sourceRoot, relativePath);
  if (!resolved.startsWith(sourceRoot)) return null;
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

export const sourceCodeServer: McpServerDefinition = {
  serverName: 'signal-bot-sourcecode',
  configKey: 'sourcecode',
  entrypoint: 'mcp/servers/sourceCode',
  tools: TOOLS,
  envMapping: { SOURCE_ROOT: 'sourceRoot' },
  handlers: {
    list_files(args) {
      if (!sourceRoot) {
        return errorResult('SOURCE_ROOT not configured.');
      }

      const relativePath = (args.path as string) || '.';
      const recursive = (args.recursive as boolean) || false;

      const resolved = resolveSafePath(relativePath);
      if (!resolved) {
        return errorResult('Invalid path.');
      }

      try {
        if (!fs.statSync(resolved).isDirectory()) {
          return errorResult(`Directory not found: ${relativePath}`);
        }
      } catch {
        return errorResult(`Directory not found: ${relativePath}`);
      }

      const files = listFilesInDir(resolved, recursive, sourceRoot);
      if (files.length === 0) {
        return ok('No files found.');
      }

      return ok(files.join('\n'));
    },

    read_file(args) {
      if (!sourceRoot) {
        return errorResult('SOURCE_ROOT not configured.');
      }

      const filePath = requireString(args, 'path');
      if (filePath.error) return filePath.error;

      const resolved = resolveSafePath(filePath.value);
      if (!resolved) {
        return errorResult('Invalid path.');
      }

      let stat: fs.Stats;
      try {
        stat = fs.statSync(resolved);
      } catch {
        return errorResult(`File not found: ${filePath.value}`);
      }
      if (!stat.isFile()) {
        return errorResult(`File not found: ${filePath.value}`);
      }

      if (stat.size > MAX_FILE_SIZE) {
        const content = fs.readFileSync(resolved, 'utf-8').substring(0, MAX_FILE_SIZE);
        return ok(`${content}\n\n[Truncated — file is ${stat.size} bytes, showing first ${MAX_FILE_SIZE} bytes]`);
      }

      const content = fs.readFileSync(resolved, 'utf-8');
      return ok(content);
    },

    search_code(args) {
      if (!sourceRoot) {
        return errorResult('SOURCE_ROOT not configured.');
      }

      const pattern = requireString(args, 'pattern');
      if (pattern.error) return pattern.error;

      let regex: RegExp;
      try {
        regex = new RegExp(pattern.value, 'i');
      } catch {
        return errorResult(`Invalid regex pattern: ${pattern.value}`);
      }

      const relativePath = (args.path as string) || '.';
      const resolved = resolveSafePath(relativePath);
      if (!resolved) {
        return errorResult('Invalid path.');
      }

      let extFilter: string | null = null;
      if (args.filePattern && typeof args.filePattern === 'string') {
        const fp = args.filePattern;
        extFilter = fp.startsWith('*') ? fp.substring(1) : fp;
      }

      const results: Array<{ file: string; line: number; text: string }> = [];
      searchRecursive(resolved, regex, sourceRoot, extFilter, results);

      if (results.length === 0) {
        return ok(`No matches found for pattern: ${pattern.value}`);
      }

      const lines = results.map(r => `${r.file}:${r.line}: ${r.text.trim()}`);
      let text = lines.join('\n');
      if (results.length >= MAX_SEARCH_MATCHES) {
        text += `\n\n[Results capped at ${MAX_SEARCH_MATCHES} matches]`;
      }

      return ok(text);
    },
  },
  onInit() {
    sourceRoot = process.env.SOURCE_ROOT || '';
    if (!sourceRoot) {
      console.error('Warning: SOURCE_ROOT not set, source code tools will not function.');
    } else {
      console.error(`Source code MCP server started (root: ${sourceRoot})`);
    }
  },
};

if (require.main === module) {
  runServer(sourceCodeServer);
}
