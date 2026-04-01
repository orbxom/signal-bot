import * as fs from 'node:fs';
import * as path from 'node:path';
import { catchErrors, error, ok } from '../result';
import { runServer } from '../runServer';
import type { McpServerDefinition } from '../types';
import { requireString } from '../validate';

const MAX_LOG_FILES = 3;
const DEFAULT_LINE_LIMIT = 50;
const MAX_OUTPUT_BYTES = 50_000;

/** Get log files matching bot-*.log, sorted most recent first (reverse alpha). */
export function getLogFiles(logsDir: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(logsDir);
  } catch {
    return [];
  }
  return entries
    .filter(f => f.startsWith('bot-') && f.endsWith('.log'))
    .sort()
    .reverse();
}

/** Read recent ERROR and WARN lines from bot log files. Pure function for testing. */
export function getRecentErrors(logsDir: string, lineLimit: number): string {
  const logFiles = getLogFiles(logsDir);
  if (logFiles.length === 0) {
    return 'No log files found in logs directory.';
  }

  const filesToRead = logFiles.slice(0, MAX_LOG_FILES);
  const sections: string[] = [];
  let totalLines = 0;
  let totalBytes = 0;

  for (const file of filesToRead) {
    if (totalLines >= lineLimit) break;

    const filePath = path.join(logsDir, file);
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    const lines = content.split('\n');
    const matchingLines: string[] = [];

    for (const line of lines) {
      if (totalLines >= lineLimit) break;
      if (line.includes('[ERROR]') || line.includes('[WARN]')) {
        const lineBytes = Buffer.byteLength(line, 'utf-8');
        if (totalBytes + lineBytes > MAX_OUTPUT_BYTES) break;
        matchingLines.push(line);
        totalLines++;
        totalBytes += lineBytes;
      }
    }

    if (matchingLines.length > 0) {
      sections.push(`--- ${file} ---\n${matchingLines.join('\n')}`);
    }
  }

  if (sections.length === 0) {
    return 'No errors or warnings found in recent log files.';
  }

  return sections.join('\n\n');
}

/** Search bot log files for a pattern with context lines around matches. */
export function searchBotLogs(logsDir: string, pattern: string, contextLines: number, lineLimit: number): string {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, 'i');
  } catch {
    return `Invalid search pattern: "${pattern}" — must be a valid regular expression.`;
  }

  const logFiles = getLogFiles(logsDir);
  if (logFiles.length === 0) {
    return 'No log files found in logs directory.';
  }

  const filesToRead = logFiles.slice(0, MAX_LOG_FILES);
  const sections: string[] = [];
  let totalLines = 0;
  let totalBytes = 0;

  for (const file of filesToRead) {
    if (totalLines >= lineLimit) break;

    const filePath = path.join(logsDir, file);
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    const lines = content.split('\n').filter(l => l.length > 0);

    // Find matching line indices
    const matchIndices: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        matchIndices.push(i);
      }
    }

    if (matchIndices.length === 0) continue;

    // Build set of all indices to include (matches + context), deduplicating
    const includeIndices = new Set<number>();
    for (const idx of matchIndices) {
      for (let c = idx - contextLines; c <= idx + contextLines; c++) {
        if (c >= 0 && c < lines.length) {
          includeIndices.add(c);
        }
      }
    }

    const matchSet = new Set(matchIndices);
    const sortedIndices = Array.from(includeIndices).sort((a, b) => a - b);
    const outputLines: string[] = [];

    for (const idx of sortedIndices) {
      if (totalLines >= lineLimit) break;
      const prefix = matchSet.has(idx) ? '> ' : '  ';
      const line = prefix + lines[idx];
      const lineBytes = Buffer.byteLength(line, 'utf-8');
      if (totalBytes + lineBytes > MAX_OUTPUT_BYTES) break;
      outputLines.push(line);
      totalLines++;
      totalBytes += lineBytes;
    }

    if (outputLines.length > 0) {
      sections.push(`--- ${file} ---\n${outputLines.join('\n')}`);
    }
  }

  if (sections.length === 0) {
    return `No matches found for pattern "${pattern}" in recent log files.`;
  }

  return sections.join('\n\n');
}

const DEFAULT_CONTEXT_LINES = 2;
const DEFAULT_SEARCH_LIMIT = 30;

const TOOLS = [
  {
    name: 'get_recent_errors',
    title: 'Get Recent Errors',
    description:
      'Get recent ERROR and WARN lines from the bot log files. Returns the most recent errors and warnings across up to 3 log files.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        max_lines: {
          type: 'number',
          description: `Maximum number of error/warning lines to return (default: ${DEFAULT_LINE_LIMIT})`,
        },
      },
    },
  },
  {
    name: 'search_bot_logs',
    title: 'Search Bot Logs',
    description:
      'Search bot log files for a pattern (case-insensitive regex). Returns matching lines with surrounding context from up to 3 most recent log files.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        pattern: {
          type: 'string',
          description: 'Search pattern (case-insensitive regex)',
        },
        context_lines: {
          type: 'number',
          description: `Number of context lines before and after each match (default: ${DEFAULT_CONTEXT_LINES})`,
        },
        max_results: {
          type: 'number',
          description: `Maximum number of result lines to return (default: ${DEFAULT_SEARCH_LIMIT})`,
        },
      },
      required: ['pattern'],
    },
  },
];

let logsDir: string;

export const botLogsServer: McpServerDefinition = {
  serverName: 'signal-bot-botlogs',
  configKey: 'botlogs',
  entrypoint: 'botLogs',
  tools: TOOLS,
  envMapping: { LOGS_DIR: 'logsDir' },
  handlers: {
    get_recent_errors(args) {
      if (!logsDir) {
        return error('LOGS_DIR not configured.');
      }

      return catchErrors(() => {
        const maxLines = typeof args.max_lines === 'number' && args.max_lines > 0 ? args.max_lines : DEFAULT_LINE_LIMIT;

        const result = getRecentErrors(logsDir, maxLines);
        return ok(result);
      }, 'Failed to get recent errors');
    },
    search_bot_logs(args) {
      if (!logsDir) {
        return error('LOGS_DIR not configured.');
      }

      const patternResult = requireString(args, 'pattern');
      if (patternResult.error) return patternResult.error;

      return catchErrors(() => {
        const ctxLines =
          typeof args.context_lines === 'number' && args.context_lines >= 0
            ? args.context_lines
            : DEFAULT_CONTEXT_LINES;
        const maxResults =
          typeof args.max_results === 'number' && args.max_results > 0 ? args.max_results : DEFAULT_SEARCH_LIMIT;

        const result = searchBotLogs(logsDir, patternResult.value, ctxLines, maxResults);
        return ok(result);
      }, 'Failed to search bot logs');
    },
  },
  onInit() {
    logsDir = process.env.LOGS_DIR || '';
    if (!logsDir) {
      console.error('Warning: LOGS_DIR not set, bot logs tools will not function.');
    } else {
      console.error(`Bot logs MCP server started (logsDir: ${logsDir})`);
    }
  },
};

export default botLogsServer;

if (require.main === module) {
  runServer(botLogsServer);
}
