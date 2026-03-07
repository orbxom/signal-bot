import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { catchErrors, error, ok } from '../result';
import { runServer } from '../runServer';
import type { McpServerDefinition } from '../types';
import { requireNumber, requireString } from '../validate';

const execFileAsync = promisify(execFile);

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

const handlers = {
  async start_dark_factory(args: Record<string, unknown>) {
    const gateErr = checkEnabled();
    if (gateErr) return gateErr;

    const issueNumber = requireNumber(args, 'issue_number');
    if (issueNumber.error) return issueNumber.error;

    return catchErrors(async () => {
      const timestamp = Date.now();
      const sessionName = `dark-factory-${issueNumber.value}-${timestamp}`;
      const root = projectRoot();
      const sessions = sessionsDir();

      // Ensure sessions directory exists
      fs.mkdirSync(sessions, { recursive: true });

      // Write zellij KDL layout file to temp location
      const layoutPath = path.join(os.tmpdir(), `${sessionName}.kdl`);
      const layoutContent = `layout {\n  pane command="bash" {\n    args "-c" "cd ${root} && claude \\"dark factory issue ${issueNumber.value}\\""\n    close_on_exit false\n  }\n}\n`;
      fs.writeFileSync(layoutPath, layoutContent);

      // Launch kitty with zellij using the layout
      await execFileAsync(
        'kitty',
        [
          '@',
          'launch',
          '--type=os-window',
          '--title',
          sessionName,
          '--',
          'zellij',
          '-s',
          sessionName,
          '--layout',
          layoutPath,
        ],
        { timeout: 10000 },
      );

      // Write session metadata
      const metadata = {
        sessionName,
        issueNumber: issueNumber.value,
        launchedAt: new Date().toISOString(),
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

    return error('Not implemented yet');
  },
};

export const darkFactoryServer: McpServerDefinition = {
  serverName: 'signal-bot-dark-factory',
  configKey: 'darkFactory',
  entrypoint: 'darkFactory',
  tools: TOOLS,
  handlers,
  envMapping: { DARK_FACTORY_ENABLED: 'darkFactoryEnabled' },
  onInit() {
    console.error('Dark Factory MCP server started');
  },
};

if (require.main === module) {
  runServer(darkFactoryServer);
}
