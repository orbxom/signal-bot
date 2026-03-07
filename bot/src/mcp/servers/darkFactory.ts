import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { catchErrors, error, ok } from '../result';
import { runServer } from '../runServer';
import type { McpServerDefinition } from '../types';
import { requireNumber, requireString } from '../validate';

function projectRoot(): string {
  return process.env.DARK_FACTORY_PROJECT_ROOT || path.resolve(__dirname, '..', '..', '..', '..');
}

function sessionsDir(): string {
  return path.join(projectRoot(), 'factory', 'sessions');
}

function checkEnabled() {
  if (!process.env.DARK_FACTORY_ENABLED) {
    return error('Dark factory tools are not enabled. Set DARK_FACTORY_ENABLED=1 to use.');
  }
  return null;
}

const TOOLS = [
  {
    name: 'start_dark_factory',
    title: 'Start Dark Factory',
    description:
      'Launch a dark factory session to autonomously work on a GitHub issue. Opens a kitty terminal with a zellij session running Claude Code interactively. Returns the session name for monitoring with read_dark_factory. Requires DARK_FACTORY_ENABLED=1.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        issue_number: {
          type: 'number',
          description: 'GitHub issue number to work on',
        },
      },
      required: ['issue_number'],
    },
  },
  {
    name: 'read_dark_factory',
    title: 'Read Dark Factory Progress',
    description:
      'Read progress from a running dark factory session. Parses Claude conversation files to extract recent assistant messages and tool usage. Requires DARK_FACTORY_ENABLED=1.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        session_name: {
          type: 'string',
          description: 'The session name returned by start_dark_factory',
        },
        last_n: {
          type: 'number',
          description: 'Number of recent assistant messages to return (default: 5)',
        },
      },
      required: ['session_name'],
    },
  },
];

interface ParsedMessage {
  text: string;
  tools: string[];
  timestamp: string;
}

function parseConversationJSONL(filePath: string, lastN: number): ParsedMessage[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(Boolean);
  const messages: ParsedMessage[] = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type !== 'assistant' || !entry.message?.content) continue;

      const contentBlocks = entry.message.content as Array<{ type: string; text?: string; name?: string }>;
      const textParts = contentBlocks.filter(b => b.type === 'text' && b.text).map(b => b.text as string);
      const toolNames = contentBlocks.filter(b => b.type === 'tool_use' && b.name).map(b => b.name as string);

      if (textParts.length > 0 || toolNames.length > 0) {
        messages.push({
          text: textParts.join('\n'),
          tools: toolNames,
          timestamp: entry.timestamp || '',
        });
      }
    } catch {
      // Skip malformed lines
    }
  }

  return messages.slice(-lastN);
}

const handlers = {
  async start_dark_factory(args: Record<string, unknown>) {
    const gateErr = checkEnabled();
    if (gateErr) return gateErr;

    const issueNumber = requireNumber(args, 'issue_number');
    if (issueNumber.error) return issueNumber.error;

    return catchErrors(async () => {
      const now = new Date();
      const sessionName = `dark-factory-${issueNumber.value}-${now.getTime()}`;
      const root = projectRoot();
      const sessions = sessionsDir();

      // Ensure sessions directory exists
      fs.mkdirSync(sessions, { recursive: true });

      // Write zellij KDL layout file to temp location
      const layoutPath = path.join(os.tmpdir(), `${sessionName}.kdl`);
      const escapedRoot = root.replace(/'/g, "'\\''");
      const layoutContent = `layout {\n  pane command="bash" {\n    args "-c" "cd '${escapedRoot}' && claude \\"/dark-factory issue ${issueNumber.value}\\""\n    close_on_exit false\n  }\n}\n`;
      fs.writeFileSync(layoutPath, layoutContent);

      // Launch a new kitty window with zellij inside it
      const child = spawn(
        'kitty',
        [
          '--title',
          sessionName,
          'zellij',
          '-s',
          sessionName,
          '--new-session-with-layout',
          layoutPath,
        ],
        { detached: true, stdio: 'ignore', env: { ...process.env, CLAUDECODE: '' } },
      );
      child.unref();

      // Write session metadata
      const metadata = {
        sessionName,
        issueNumber: issueNumber.value,
        launchedAt: now.toISOString(),
        layoutPath,
      };
      fs.writeFileSync(path.join(sessions, `${sessionName}.json`), JSON.stringify(metadata, null, 2));

      return ok(
        `Dark factory session started.\n` +
          `Session: ${sessionName}\n` +
          `Issue: #${issueNumber.value}\n` +
          `Use read_dark_factory with session_name "${sessionName}" to monitor progress.`,
      );
    }, 'Failed to start dark factory session');
  },

  async read_dark_factory(args: Record<string, unknown>) {
    const gateErr = checkEnabled();
    if (gateErr) return gateErr;

    const sessionName = requireString(args, 'session_name');
    if (sessionName.error) return sessionName.error;

    return catchErrors(() => {
      const lastN = Math.max(1, Math.min(typeof args.last_n === 'number' ? args.last_n : 5, 50));
      const sessions = sessionsDir();
      const safeName = path.basename(sessionName.value);
      const metadataPath = path.join(sessions, `${safeName}.json`);

      let metadata: { sessionName: string; issueNumber: number; launchedAt: string };
      try {
        metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
      } catch {
        return error(`No session found: ${sessionName.value}`);
      }
      const launchedAt = new Date(metadata.launchedAt).getTime();

      // Path encoding: /home/user/project → -home-user-project
      const claudeDir = path.join(os.homedir(), '.claude', 'projects', projectRoot().replace(/\//g, '-'));

      // Find JSONL files modified after launch, then match by issue number
      let dirEntries: string[];
      try {
        dirEntries = fs.readdirSync(claudeDir);
      } catch {
        return ok(`Session: ${sessionName.value}\nNo Claude conversation directory found.`);
      }

      const candidates = dirEntries
        .filter(f => f.endsWith('.jsonl'))
        .map(f => ({ name: f, mtime: fs.statSync(path.join(claudeDir, f)).mtimeMs }))
        .filter(f => f.mtime >= launchedAt - 5000)
        .sort((a, b) => b.mtime - a.mtime);

      if (candidates.length === 0) {
        return ok(
          `Session: ${sessionName.value}\n` +
            `Issue: #${metadata.issueNumber}\n` +
            `No conversation file found yet. Claude may still be starting up.`,
        );
      }

      // Find the file containing our dark factory prompt
      const issuePattern = `/dark-factory issue ${metadata.issueNumber}`;
      let jsonlPath = path.join(claudeDir, candidates[0].name); // fallback to newest
      for (const candidate of candidates) {
        const filePath = path.join(claudeDir, candidate.name);
        const buf = Buffer.alloc(5000);
        const fd = fs.openSync(filePath, 'r');
        const bytesRead = fs.readSync(fd, buf, 0, 5000, 0);
        fs.closeSync(fd);
        if (buf.subarray(0, bytesRead).toString('utf-8').includes(issuePattern)) {
          jsonlPath = filePath;
          break;
        }
      }

      const messages = parseConversationJSONL(jsonlPath, lastN);

      if (messages.length === 0) {
        return ok(
          `Session: ${sessionName.value}\n` +
            `Issue: #${metadata.issueNumber}\n` +
            `Session started but no assistant responses yet.`,
        );
      }

      let summary = `Session: ${sessionName.value}\n`;
      summary += `Issue: #${metadata.issueNumber}\n`;
      summary += `Showing last ${messages.length} messages:\n\n`;

      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        summary += `--- Message ${i + 1} ---\n`;
        const text = msg.text.length > 500 ? `${msg.text.slice(0, 500)}...[truncated]` : msg.text;
        if (text) summary += `${text}\n`;
        if (msg.tools.length > 0) {
          summary += `Tools: ${msg.tools.join(', ')}\n`;
        }
        summary += '\n';
      }

      return ok(summary);
    }, 'Failed to read dark factory session');
  },
};

export const darkFactoryServer: McpServerDefinition = {
  serverName: 'signal-bot-dark-factory',
  configKey: 'darkFactory',
  entrypoint: 'darkFactory',
  tools: TOOLS,
  handlers,
  envMapping: { DARK_FACTORY_ENABLED: 'darkFactoryEnabled', DARK_FACTORY_PROJECT_ROOT: 'darkFactoryProjectRoot' },
  onInit() {
    console.error('Dark Factory MCP server started');
  },
};

if (require.main === module) {
  runServer(darkFactoryServer);
}
