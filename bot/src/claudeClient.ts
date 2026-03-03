import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getErrorMessage } from './mcpServerBase';
import type { ChatMessage, LLMResponse, MessageContext } from './types';

interface ClaudeResultLine {
  type: 'result';
  result: string;
  is_error: boolean;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

const BASE_TOOLS = 'WebSearch,WebFetch,Read,Glob,Grep,Agent';
const MCP_TOOLS = [
  'mcp__reminders__set_reminder',
  'mcp__reminders__list_reminders',
  'mcp__reminders__cancel_reminder',
  'mcp__weather__search_location',
  'mcp__weather__get_observations',
  'mcp__weather__get_forecast',
  'mcp__weather__get_warnings',
  'mcp__github__create_feature_request',
  'mcp__dossiers__update_dossier',
  'mcp__dossiers__get_dossier',
  'mcp__dossiers__list_dossiers',
  'mcp__sourcecode__list_files',
  'mcp__sourcecode__read_file',
  'mcp__sourcecode__search_code',
  'mcp__history__search_messages',
  'mcp__history__get_messages_by_date',
  'mcp__personas__create_persona',
  'mcp__personas__get_persona',
  'mcp__personas__list_personas',
  'mcp__personas__update_persona',
  'mcp__personas__delete_persona',
  'mcp__personas__switch_persona',
].join(',');
const ALLOWED_TOOLS = `${BASE_TOOLS},${MCP_TOOLS}`;

// Resolve MCP server path for dev (tsx) vs production (compiled JS)
const mcpPathCache = new Map<string, { command: string; args: string[] }>();
function resolveMcpServerPath(name: string): { command: string; args: string[] } {
  const cached = mcpPathCache.get(name);
  if (cached) return cached;
  const jsPath = path.resolve(__dirname, `${name}.js`);
  const tsPath = path.resolve(__dirname, `${name}.ts`);
  const useTs = !fs.existsSync(jsPath) && fs.existsSync(tsPath);
  const result = {
    command: useTs ? 'npx' : 'node',
    args: useTs ? ['tsx', tsPath] : [jsPath],
  };
  mcpPathCache.set(name, result);
  return result;
}

function spawnPromise(
  cmd: string,
  args: string[],
  options: { timeout?: number; env?: NodeJS.ProcessEnv },
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.end();

    const stdoutChunks: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    const timer = options.timeout
      ? setTimeout(() => {
          child.kill();
          reject(new Error('Claude CLI timed out'));
        }, options.timeout)
      : null;

    child.on('close', code => {
      if (timer) clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString();
      if (code !== 0) {
        reject(new Error(stderr || `claude exited with code ${code}`));
      } else {
        resolve({ stdout });
      }
    });
    child.on('error', err => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
  });
}

export class ClaudeCLIClient {
  private maxTurns: number;

  constructor(maxTurns: number = 1) {
    if (maxTurns < 1) {
      throw new Error('maxTurns must be at least 1');
    }
    this.maxTurns = maxTurns;
  }

  async generateResponse(messages: ChatMessage[], context?: MessageContext): Promise<LLMResponse> {
    if (!messages || messages.length === 0) {
      throw new Error('Messages array cannot be empty');
    }

    // Extract system prompt and conversation messages
    const systemPrompt = messages.find(m => m.role === 'system')?.content;
    const conversationMessages = messages.filter(m => m.role !== 'system');

    // Build prompt from conversation history
    const prompt = conversationMessages
      .map(m => {
        if (m.role === 'assistant') return `Assistant: ${m.content}`;
        return m.content;
      })
      .join('\n\n');

    const args = [
      '-p',
      prompt,
      '--output-format',
      'json',
      '--max-turns',
      String(this.maxTurns),
      '--no-session-persistence',
      '--allowedTools',
      ALLOWED_TOOLS,
    ];

    if (context) {
      const reminders = resolveMcpServerPath('reminderMcpServer');
      const weather = resolveMcpServerPath('weatherMcpServer');
      const github = resolveMcpServerPath('githubMcpServer');
      const dossiers = resolveMcpServerPath('dossierMcpServer');
      const sourcecode = resolveMcpServerPath('sourceCodeMcpServer');
      const history = resolveMcpServerPath('messageHistoryMcpServer');
      const personas = resolveMcpServerPath('personaMcpServer');
      const mcpConfig = JSON.stringify({
        mcpServers: {
          reminders: {
            command: reminders.command,
            args: reminders.args,
            env: {
              DB_PATH: context.dbPath,
              MCP_GROUP_ID: context.groupId,
              MCP_SENDER: context.sender,
              TZ: context.timezone,
            },
          },
          weather: {
            command: weather.command,
            args: weather.args,
            env: {
              TZ: context.timezone,
            },
          },
          github: {
            command: github.command,
            args: github.args,
            env: {
              GITHUB_REPO: context.githubRepo || '',
              MCP_SENDER: context.sender,
            },
          },
          dossiers: {
            command: dossiers.command,
            args: dossiers.args,
            env: {
              DB_PATH: context.dbPath,
              MCP_GROUP_ID: context.groupId,
              MCP_SENDER: context.sender,
            },
          },
          sourcecode: {
            command: sourcecode.command,
            args: sourcecode.args,
            env: {
              SOURCE_ROOT: context.sourceRoot,
            },
          },
          history: {
            command: history.command,
            args: history.args,
            env: {
              DB_PATH: context.dbPath,
              MCP_GROUP_ID: context.groupId,
              TZ: context.timezone,
            },
          },
          personas: {
            command: personas.command,
            args: personas.args,
            env: {
              DB_PATH: context.dbPath,
              MCP_GROUP_ID: context.groupId,
              MCP_SENDER: context.sender,
            },
          },
        },
      });
      args.push('--mcp-config', mcpConfig, '--strict-mcp-config');

      const agentsConfig = JSON.stringify({
        'message-historian': {
          description:
            'Searches and summarizes historical messages from this group chat. Use when someone asks about past conversations, what was said before, or wants to find old messages.',
          prompt: `You search through chat history and return concise summaries. Use search_messages for keyword lookups and get_messages_by_date for date ranges. Quote relevant messages directly with timestamps and sender names. Timezone: ${context.timezone}`,
          tools: ['mcp__history__search_messages', 'mcp__history__get_messages_by_date'],
          model: 'haiku',
        },
      });
      args.push('--agents', agentsConfig);
    }

    if (systemPrompt) {
      args.push('--system-prompt', systemPrompt);
    }

    try {
      const { stdout } = await spawnPromise('claude', args, {
        timeout: 120000,
        env: { ...process.env, CLAUDECODE: '' },
      });

      // Output may be a JSON array or NDJSON — parse all entries
      const trimmed = stdout.trim();
      let entries: Array<Record<string, unknown>> = [];

      if (trimmed.startsWith('[')) {
        entries = JSON.parse(trimmed);
      } else {
        for (const line of trimmed.split('\n')) {
          try {
            entries.push(JSON.parse(line));
          } catch {
            /* skip */
          }
        }
      }

      // Single pass: find result line and last assistant entry
      let resultLine: ClaudeResultLine | undefined;
      let lastAssistant: { message?: { content?: Array<{ type: string; text?: string }> } } | undefined;
      for (const e of entries) {
        if (e.type === 'result') resultLine = e as unknown as ClaudeResultLine;
        if (e.type === 'assistant') lastAssistant = e as unknown as typeof lastAssistant;
      }

      if (!resultLine) {
        console.error(
          '[Claude] No result line in output. Entry types:',
          entries.map(e => e.type),
        );
        throw new Error('No result found in Claude CLI output');
      }

      // Prefer result field, fall back to last assistant message text
      let content = '';

      if (resultLine.is_error) {
        console.warn(
          `[Claude] Result has is_error=true, subtype=${(resultLine as unknown as Record<string, unknown>).subtype}. Falling back to assistant text.`,
        );
      } else {
        content = typeof resultLine.result === 'string' ? resultLine.result.trim() : '';
      }

      if (!content) {
        // Extract text from the last assistant message
        const textBlocks = lastAssistant?.message?.content?.filter(b => b.type === 'text') || [];
        content = textBlocks
          .map(b => b.text || '')
          .join('')
          .trim();
        if (content) {
          console.log(`[Claude] Used fallback: extracted ${content.length} chars from assistant message`);
        }
      }

      if (!content) {
        console.error('[Claude] No content found. Full output:', JSON.stringify(entries, null, 2).substring(0, 2000));
        throw new Error('No response content from Claude CLI');
      }

      return {
        content,
        tokensUsed: resultLine.usage?.output_tokens || 0,
      };
    } catch (error) {
      if (error instanceof Error) {
        // Re-throw our own errors
        if (error.message.startsWith('No result found') || error.message.startsWith('No response content')) {
          throw error;
        }
        if (error.message.includes('ETIMEDOUT') || error.message.includes('killed')) {
          throw new Error('Claude CLI timed out');
        }
        if (error.message.includes('ENOENT')) {
          throw new Error('Claude CLI not found. Install it: npm install -g @anthropic-ai/claude-code');
        }
      }
      throw new Error(`Failed to generate response from Claude CLI: ${getErrorMessage(error)}`);
    }
  }
}
