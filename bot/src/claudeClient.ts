import { spawn } from 'node:child_process';
import path from 'node:path';
import type { ChatMessage, LLMResponse } from './types';

export interface MessageContext {
  groupId: string;
  sender: string;
  dbPath: string;
  timezone: string;
}

interface ClaudeResultLine {
  type: 'result';
  result: string;
  is_error: boolean;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

const BASE_TOOLS = 'WebSearch,WebFetch,Read,Glob,Grep';
const MCP_TOOLS = 'mcp__reminders__set_reminder,mcp__reminders__list_reminders,mcp__reminders__cancel_reminder';
const ALLOWED_TOOLS = `${BASE_TOOLS},${MCP_TOOLS}`;

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
      const mcpServerPath = path.resolve(__dirname, 'reminderMcpServer.js');
      const mcpConfig = JSON.stringify({
        mcpServers: {
          reminders: {
            command: 'node',
            args: [mcpServerPath],
            env: {
              DB_PATH: context.dbPath,
              MCP_GROUP_ID: context.groupId,
              MCP_SENDER: context.sender,
              TZ: context.timezone,
            },
          },
        },
      });
      args.push('--mcp-config', mcpConfig, '--strict-mcp-config');
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
      const msg = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to generate response from Claude CLI: ${msg}`);
    }
  }
}
