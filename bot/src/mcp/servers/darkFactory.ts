import { error } from '../result';
import { runServer } from '../runServer';
import type { McpServerDefinition } from '../types';
import { requireNumber, requireString } from '../validate';

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

    return error('Not implemented yet');
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
