import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readStorageEnv } from '../env';
import { catchErrors, error, ok } from '../result';
import { runServer } from '../runServer';
import type { McpServerDefinition } from '../types';
import { requireString } from '../validate';

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

let githubRepo: string;
let sender: string;

export const githubServer: McpServerDefinition = {
  serverName: 'signal-bot-github',
  configKey: 'github',
  entrypoint: 'github',
  tools: TOOLS,
  envMapping: { GITHUB_REPO: 'githubRepo', MCP_SENDER: 'sender' },
  handlers: {
    async create_feature_request(args) {
      const title = requireString(args, 'title');
      if (title.error) return title.error;
      const body = requireString(args, 'body');
      if (body.error) return body.error;
      const labels = Array.isArray(args.labels) ? (args.labels as string[]) : ['feature-request'];

      if (!githubRepo) {
        return error('GITHUB_REPO environment variable is not configured.');
      }
      if (!/^[\w.-]+\/[\w.-]+$/.test(githubRepo)) {
        return error(`Invalid GITHUB_REPO format: "${githubRepo}". Expected "owner/repo".`);
      }

      const fullBody = sender ? `${body.value}\n\n---\n_Requested via Signal by ${sender}_` : body.value;

      return catchErrors(async () => {
        const ghArgs = ['issue', 'create', '--repo', githubRepo, '--title', title.value, '--body', fullBody];
        for (const label of labels) {
          ghArgs.push('--label', label);
        }

        const { stdout } = await execFileAsync('gh', ghArgs, { timeout: 30000 });
        const issueUrl = stdout.trim();

        return ok(`Feature request created: ${issueUrl}`);
      }, 'Failed to create issue');
    },
  },
  onInit() {
    const env = readStorageEnv();
    githubRepo = process.env.GITHUB_REPO || '';
    sender = env.sender;
    console.error('GitHub MCP server started');
  },
};

if (require.main === module) {
  runServer(githubServer);
}
