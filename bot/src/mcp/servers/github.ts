import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readStorageEnv } from '../env';
import { catchErrors, error, ok } from '../result';
import { runServer } from '../runServer';
import type { McpServerDefinition } from '../types';
import { optionalString, requireNumber, requireString } from '../validate';

const execFileAsync = promisify(execFile);

const GH_TIMEOUT = 30000;
const MAX_DIFF_CHARS = 50000;
const MERGE_STRATEGIES = ['merge', 'squash', 'rebase'] as const;

const REVIEW_EVENT_FLAGS: Record<string, string> = {
  APPROVE: '--approve',
  REQUEST_CHANGES: '--request-changes',
  COMMENT: '--comment',
};

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
          description: 'Labels to apply to the issue. Defaults to ["feature-request", "claude-work"].',
        },
      },
      required: ['title', 'body'],
    },
  },
  {
    name: 'list_pull_requests',
    title: 'List Pull Requests',
    description: 'List pull requests in the repository. Returns PR number, title, author, state, and draft status.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        state: {
          type: 'string',
          enum: ['open', 'closed', 'all'],
          description: 'Filter by state. Defaults to "open".',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of PRs to return. Defaults to 10.',
        },
      },
    },
  },
  {
    name: 'view_pull_request',
    title: 'View Pull Request',
    description:
      'View details of a specific pull request including title, body, state, author, reviewers, diff stats, and merge status.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        number: {
          type: 'number',
          description: 'The pull request number.',
        },
      },
      required: ['number'],
    },
  },
  {
    name: 'get_pr_diff',
    title: 'Get PR Diff',
    description: 'Get the unified diff of a pull request. Large diffs are truncated.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        number: {
          type: 'number',
          description: 'The pull request number.',
        },
      },
      required: ['number'],
    },
  },
  {
    name: 'comment_on_pull_request',
    title: 'Comment on Pull Request',
    description: 'Add a comment to a pull request.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        number: {
          type: 'number',
          description: 'The pull request number.',
        },
        body: {
          type: 'string',
          description: 'The comment text.',
        },
      },
      required: ['number', 'body'],
    },
  },
  {
    name: 'review_pull_request',
    title: 'Review Pull Request',
    description: 'Submit a review on a pull request. Event must be APPROVE, REQUEST_CHANGES, or COMMENT.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        number: {
          type: 'number',
          description: 'The pull request number.',
        },
        event: {
          type: 'string',
          enum: Object.keys(REVIEW_EVENT_FLAGS),
          description: 'The review action to take.',
        },
        body: {
          type: 'string',
          description: 'Review comment text. Required for REQUEST_CHANGES and COMMENT.',
        },
      },
      required: ['number', 'event'],
    },
  },
  {
    name: 'merge_pull_request',
    title: 'Merge Pull Request',
    description: 'Merge a pull request. Supports merge, squash, or rebase strategies.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        number: {
          type: 'number',
          description: 'The pull request number.',
        },
        strategy: {
          type: 'string',
          enum: [...MERGE_STRATEGIES],
          description: 'Merge strategy. Defaults to "squash".',
        },
      },
      required: ['number'],
    },
  },
];

let githubRepo: string;
let sender: string;

function validateRepo() {
  if (!githubRepo) {
    return error('GITHUB_REPO environment variable is not configured.');
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(githubRepo)) {
    return error(`Invalid GITHUB_REPO format: "${githubRepo}". Expected "owner/repo".`);
  }
  return null;
}

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
      const labels = Array.isArray(args.labels) ? (args.labels as string[]) : ['feature-request', 'claude-work'];

      const repoErr = validateRepo();
      if (repoErr) return repoErr;

      const fullBody = sender ? `${body.value}\n\n---\n_Requested via Signal by ${sender}_` : body.value;

      return catchErrors(async () => {
        const ghArgs = ['issue', 'create', '--repo', githubRepo, '--title', title.value, '--body', fullBody];
        for (const label of labels) {
          ghArgs.push('--label', label);
        }

        const { stdout } = await execFileAsync('gh', ghArgs, { timeout: GH_TIMEOUT });
        const issueUrl = stdout.trim();

        return ok(`Feature request created: ${issueUrl}`);
      }, 'Failed to create issue');
    },

    async list_pull_requests(args) {
      const repoErr = validateRepo();
      if (repoErr) return repoErr;

      const state = optionalString(args, 'state', 'open');
      const limit = typeof args.limit === 'number' ? args.limit : 10;

      return catchErrors(async () => {
        const { stdout } = await execFileAsync(
          'gh',
          [
            'pr',
            'list',
            '--repo',
            githubRepo,
            '--state',
            state,
            '--limit',
            String(limit),
            '--json',
            'number,title,state,author,url,isDraft',
          ],
          { timeout: GH_TIMEOUT },
        );

        const prs = JSON.parse(stdout) as Array<{
          number: number;
          title: string;
          state: string;
          author: { login: string };
          url: string;
          isDraft: boolean;
        }>;

        if (prs.length === 0) {
          return ok(`No ${state} pull requests found.`);
        }

        const lines = prs.map(
          pr =>
            `#${pr.number} ${pr.isDraft ? '[DRAFT] ' : ''}${pr.title} (by ${pr.author.login}) — ${pr.state}\n  ${pr.url}`,
        );
        return ok(lines.join('\n\n'));
      }, 'Failed to list pull requests');
    },

    async view_pull_request(args) {
      const num = requireNumber(args, 'number');
      if (num.error) return num.error;
      const repoErr = validateRepo();
      if (repoErr) return repoErr;

      return catchErrors(async () => {
        const { stdout } = await execFileAsync('gh', ['api', `repos/${githubRepo}/pulls/${num.value}`], {
          timeout: GH_TIMEOUT,
        });

        const pr = JSON.parse(stdout) as {
          number: number;
          title: string;
          body: string;
          state: string;
          draft: boolean;
          merged: boolean;
          user: { login: string };
          head: { ref: string };
          base: { ref: string };
          additions: number;
          deletions: number;
          changed_files: number;
          labels: Array<{ name: string }>;
          html_url: string;
          requested_reviewers: Array<{ login: string }>;
        };

        const labels = pr.labels.map(l => l.name).join(', ') || 'none';
        const reviewers = pr.requested_reviewers.map(r => r.login).join(', ') || 'none';
        const status = pr.merged ? 'merged' : pr.draft ? 'draft' : pr.state;

        const summary = [
          `# PR #${pr.number}: ${pr.title}`,
          `**Status:** ${status}`,
          `**Author:** ${pr.user.login}`,
          `**Branch:** ${pr.head.ref} → ${pr.base.ref}`,
          `**Labels:** ${labels}`,
          `**Reviewers:** ${reviewers}`,
          `**Changes:** +${pr.additions} -${pr.deletions} (${pr.changed_files} files)`,
          `**URL:** ${pr.html_url}`,
          '',
          pr.body || '_No description provided._',
        ].join('\n');

        return ok(summary);
      }, 'Failed to view pull request');
    },

    async get_pr_diff(args) {
      const num = requireNumber(args, 'number');
      if (num.error) return num.error;
      const repoErr = validateRepo();
      if (repoErr) return repoErr;

      return catchErrors(async () => {
        const { stdout } = await execFileAsync('gh', ['pr', 'diff', String(num.value), '--repo', githubRepo], {
          timeout: GH_TIMEOUT,
          maxBuffer: 10 * 1024 * 1024,
        });

        if (stdout.length > MAX_DIFF_CHARS) {
          return ok(
            `${stdout.slice(0, MAX_DIFF_CHARS)}\n\n... [truncated — diff is ${stdout.length} characters, showing first ${MAX_DIFF_CHARS}]`,
          );
        }
        return ok(stdout || 'No diff available (empty diff).');
      }, 'Failed to get PR diff');
    },

    async comment_on_pull_request(args) {
      const num = requireNumber(args, 'number');
      if (num.error) return num.error;
      const body = requireString(args, 'body');
      if (body.error) return body.error;
      const repoErr = validateRepo();
      if (repoErr) return repoErr;

      return catchErrors(async () => {
        const { stdout } = await execFileAsync(
          'gh',
          ['pr', 'comment', String(num.value), '--repo', githubRepo, '--body', body.value],
          { timeout: GH_TIMEOUT },
        );
        return ok(stdout.trim() || `Comment added to PR #${num.value}.`);
      }, 'Failed to comment on pull request');
    },

    async review_pull_request(args) {
      const num = requireNumber(args, 'number');
      if (num.error) return num.error;
      const event = requireString(args, 'event');
      if (event.error) return event.error;
      const repoErr = validateRepo();
      if (repoErr) return repoErr;

      const flag = REVIEW_EVENT_FLAGS[event.value];
      if (!flag) {
        return error(`Invalid event "${event.value}". Must be APPROVE, REQUEST_CHANGES, or COMMENT.`);
      }

      const reviewBody = optionalString(args, 'body', '');
      if ((event.value === 'REQUEST_CHANGES' || event.value === 'COMMENT') && !reviewBody) {
        return error(`Body is required for ${event.value} reviews.`);
      }

      return catchErrors(async () => {
        const ghArgs = ['pr', 'review', String(num.value), '--repo', githubRepo, flag];
        if (reviewBody) {
          ghArgs.push('--body', reviewBody);
        }

        await execFileAsync('gh', ghArgs, { timeout: GH_TIMEOUT });
        return ok(`Review submitted on PR #${num.value}: ${event.value}.`);
      }, 'Failed to review pull request');
    },

    async merge_pull_request(args) {
      const num = requireNumber(args, 'number');
      if (num.error) return num.error;
      const repoErr = validateRepo();
      if (repoErr) return repoErr;

      const strategy = optionalString(args, 'strategy', 'squash');
      if (!(MERGE_STRATEGIES as readonly string[]).includes(strategy)) {
        return error(`Invalid strategy "${strategy}". Must be merge, squash, or rebase.`);
      }

      return catchErrors(async () => {
        const { stdout } = await execFileAsync(
          'gh',
          ['pr', 'merge', String(num.value), '--repo', githubRepo, `--${strategy}`],
          { timeout: GH_TIMEOUT },
        );
        return ok(stdout.trim() || `PR #${num.value} merged via ${strategy}.`);
      }, 'Failed to merge pull request');
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
