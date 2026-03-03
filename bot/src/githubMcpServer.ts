import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getErrorMessage, runMcpServer, type ToolResult } from './mcpServerBase';

const execFileAsync = promisify(execFile);

const GITHUB_REPO = process.env.GITHUB_REPO || '';
const MCP_SENDER = process.env.MCP_SENDER || '';

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

async function handleCreateFeatureRequest(args: Record<string, unknown>): Promise<ToolResult> {
  const title = args.title as string;
  const body = args.body as string;
  const labels = (args.labels as string[]) || ['feature-request'];

  if (!title || typeof title !== 'string') {
    return { content: [{ type: 'text', text: 'Missing or invalid title.' }], isError: true };
  }
  if (!body || typeof body !== 'string') {
    return { content: [{ type: 'text', text: 'Missing or invalid body.' }], isError: true };
  }
  if (!GITHUB_REPO) {
    return {
      content: [{ type: 'text', text: 'GITHUB_REPO environment variable is not configured.' }],
      isError: true,
    };
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(GITHUB_REPO)) {
    return {
      content: [{ type: 'text', text: `Invalid GITHUB_REPO format: "${GITHUB_REPO}". Expected "owner/repo".` }],
      isError: true,
    };
  }

  const fullBody = MCP_SENDER ? `${body}\n\n---\n_Requested via Signal by ${MCP_SENDER}_` : body;

  try {
    const ghArgs = ['issue', 'create', '--repo', GITHUB_REPO, '--title', title, '--body', fullBody];
    for (const label of labels) {
      ghArgs.push('--label', label);
    }

    const { stdout } = await execFileAsync('gh', ghArgs, { timeout: 30000 });
    const issueUrl = stdout.trim();

    return { content: [{ type: 'text', text: `Feature request created: ${issueUrl}` }] };
  } catch (error) {
    const msg = getErrorMessage(error);
    if (msg.includes('ENOENT')) {
      return { content: [{ type: 'text', text: 'GitHub CLI (gh) is not installed.' }], isError: true };
    }
    return { content: [{ type: 'text', text: `Failed to create issue: ${msg}` }], isError: true };
  }
}

async function handleToolCall(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  try {
    switch (name) {
      case 'create_feature_request':
        return await handleCreateFeatureRequest(args);
      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (error) {
    return { content: [{ type: 'text', text: `GitHub error: ${getErrorMessage(error)}` }], isError: true };
  }
}

runMcpServer({
  name: 'signal-bot-github',
  tools: TOOLS,
  handleToolCall,
  onInit() {
    console.error('GitHub MCP server started');
  },
});
