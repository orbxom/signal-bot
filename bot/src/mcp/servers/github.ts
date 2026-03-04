import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { error, getErrorMessage, ok } from '../result';
import { runServer } from '../runServer';
import type { McpServerDefinition } from '../types';

const execFileAsync = promisify(execFile);

const TOOLS = [
  {
    name: 'create_feature_request',
    title: 'Create Feature Request',
    description:
      'Create a GitHub issue for a feature request. Use this when a user asks for a new feature or enhancement for the bot. Compose a clear title and detailed body from their request.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        title: {
          type: 'string',
          description: 'Short, descriptive title for the feature request issue',
        },
        body: {
          type: 'string',
          description:
            'Detailed description of the feature request. Include context about what the user wants and why.',
        },
        labels: {
          type: 'array',
          items: { type: 'string' },
          description: 'Labels to apply to the issue. Defaults to ["feature-request"].',
        },
      },
      required: ['title', 'body'],
    },
  },
];

export const githubServer: McpServerDefinition = {
  serverName: 'signal-bot-github',
  configKey: 'github',
  entrypoint: 'mcp/servers/github',
  tools: TOOLS,
  envMapping: { GITHUB_REPO: 'githubRepo', MCP_SENDER: 'sender' },
  handlers: {
    async create_feature_request(args) {
      const title = args.title as string;
      const body = args.body as string;
      const labels = (args.labels as string[]) || ['feature-request'];

      if (!title || typeof title !== 'string') {
        return error('Missing or invalid title.');
      }
      if (!body || typeof body !== 'string') {
        return error('Missing or invalid body.');
      }

      const GITHUB_REPO = process.env.GITHUB_REPO || '';
      const MCP_SENDER = process.env.MCP_SENDER || '';

      if (!GITHUB_REPO) {
        return error('GITHUB_REPO environment variable is not configured.');
      }
      if (!/^[\w.-]+\/[\w.-]+$/.test(GITHUB_REPO)) {
        return error(`Invalid GITHUB_REPO format: "${GITHUB_REPO}". Expected "owner/repo".`);
      }

      const fullBody = MCP_SENDER ? `${body}\n\n---\n_Requested via Signal by ${MCP_SENDER}_` : body;

      try {
        const ghArgs = ['issue', 'create', '--repo', GITHUB_REPO, '--title', title, '--body', fullBody];
        for (const label of labels) {
          ghArgs.push('--label', label);
        }

        const { stdout } = await execFileAsync('gh', ghArgs, { timeout: 30000 });
        const issueUrl = stdout.trim();

        return ok(`Feature request created: ${issueUrl}`);
      } catch (err) {
        const msg = getErrorMessage(err);
        if (msg.includes('ENOENT')) {
          return error('GitHub CLI (gh) is not installed.');
        }
        return error(`Failed to create issue: ${msg}`);
      }
    },
  },
  onInit() {
    console.error('GitHub MCP server started');
  },
};

if (require.main === module) {
  runServer(githubServer);
}
