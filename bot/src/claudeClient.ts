import { type ChildProcess, spawn } from 'node:child_process';
import { logger } from './logger';
import { buildAllowedTools, buildMcpConfig } from './mcp/registry';
import { getErrorMessage } from './mcp/result';
import { SpawnLimiter } from './spawnLimiter';
import type { ChatMessage, LLMClient, LLMResponse, MessageContext, ToolCall } from './types';

export const spawnLimiter = new SpawnLimiter(2);

/** Strip markdown code fences (```json ... ```) that Claude sometimes wraps around JSON output. */
export function stripCodeFences(text: string): string {
  return text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
}

/**
 * Spawn a command, collect stdout, and resolve on exit code 0.
 * Handles timeout with SIGTERM→SIGKILL escalation. Does NOT manage concurrency —
 * callers are responsible for their own limiter acquire/release.
 */
export function spawnCollect(
  cmd: string,
  args: string[],
  options: {
    timeout?: number;
    env?: NodeJS.ProcessEnv;
    trackChild?: (child: ChildProcess) => void;
    onStderr?: (line: string) => void;
  },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.end();
    options.trackChild?.(child);

    const stdoutChunks: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (data: Buffer) => {
      const text = data.toString();
      stderr += text;
      if (options.onStderr) {
        for (const line of text.split('\n').filter(Boolean)) {
          options.onStderr(line);
        }
      }
    });

    const timer = options.timeout
      ? setTimeout(() => {
          const partialStdout = Buffer.concat(stdoutChunks).toString();
          logger.warn(
            `${cmd} timed out after ${((options.timeout || 0) / 1000).toFixed(0)}s. stderr (${stderr.length} chars): ${stderr.substring(0, 500) || '(empty)'}`,
          );
          logger.warn(
            `${cmd} partial stdout (${partialStdout.length} chars, last 1500): ${partialStdout.substring(partialStdout.length - 1500) || '(empty)'}`,
          );

          child.kill();
          setTimeout(() => {
            try {
              if (!child.killed) child.kill('SIGKILL');
            } catch {}
          }, 5000);
          reject(new Error(`${cmd} timed out`));
        }, options.timeout)
      : null;

    child.on('close', code => {
      if (timer) clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr || `${cmd} exited with code ${code}`));
      } else {
        resolve(Buffer.concat(stdoutChunks).toString());
      }
    });
    child.on('error', err => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
  });
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

let cachedAllowedTools: string | undefined;
function getAllowedTools(): string {
  if (!cachedAllowedTools) {
    cachedAllowedTools = buildAllowedTools();
  }
  return cachedAllowedTools;
}

export async function spawnPromise(
  cmd: string,
  args: string[],
  options: { timeout?: number; env?: NodeJS.ProcessEnv; onStderr?: (line: string) => void },
): Promise<{ stdout: string }> {
  await spawnLimiter.acquire();
  try {
    const stdout = await spawnCollect(cmd, args, {
      ...options,
      trackChild: child => spawnLimiter.trackChild(child),
    });
    return { stdout };
  } finally {
    spawnLimiter.release();
  }
}

/** Parse raw Claude CLI stdout into entries (JSON array or NDJSON). */
export function parseEntries(stdout: string): Array<Record<string, unknown>> {
  const trimmed = stdout.trim();
  if (trimmed.startsWith('[')) {
    return JSON.parse(trimmed);
  }
  const entries: Array<Record<string, unknown>> = [];
  for (const line of trimmed.split('\n')) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      /* skip */
    }
  }
  return entries;
}

/** Parse raw Claude CLI stdout into a structured response including tool calls. */
export function parseClaudeOutput(stdout: string): LLMResponse & { inputTokens: number } {
  const entries = parseEntries(stdout);

  // Single pass: find result line, last assistant entry, MCP send_message calls, and all tool calls
  let resultLine: ClaudeResultLine | undefined;
  let lastAssistant: { message?: { content?: Array<{ type: string; text?: string }> } } | undefined;
  const mcpMessages: string[] = [];
  const toolCalls: ToolCall[] = [];
  for (const e of entries) {
    if (e.type === 'result') resultLine = e as unknown as ClaudeResultLine;
    if (e.type === 'assistant') {
      lastAssistant = e as unknown as typeof lastAssistant;

      const msg = e as unknown as {
        message?: {
          content?: Array<{ type: string; name?: string; input?: Record<string, unknown> }>;
        };
      };
      for (const block of msg.message?.content || []) {
        if (block.type === 'tool_use') {
          if (block.name) toolCalls.push({ name: block.name, input: block.input });
          if (block.name === 'mcp__signal__send_message' && block.input?.message) {
            mcpMessages.push(block.input.message as string);
          }
          if (block.name === 'mcp__signal__send_image') {
            const caption = block.input?.caption as string | undefined;
            mcpMessages.push(caption ? `[sent an image: ${caption}]` : '[sent an image]');
          }
        }
      }
    }
  }

  if (!resultLine) {
    logger.error(`No result line in output. Entry types: ${entries.map(e => e.type).join(', ')}`);
    throw new Error('No result found in Claude CLI output');
  }

  // Prefer result field, fall back to last assistant message text
  let content = '';

  if (resultLine.is_error) {
    logger.warn(
      `Result has is_error=true, subtype=${(resultLine as unknown as Record<string, unknown>).subtype}. Falling back to assistant text.`,
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
      logger.debug(`Used fallback: extracted ${content.length} chars from assistant message`);
    }
  }

  if (!content) {
    if (mcpMessages.length === 0) {
      logger.error(`No content found. Full output: ${JSON.stringify(entries, null, 2).substring(0, 2000)}`);
      throw new Error('No response content from Claude CLI');
    }
    // Response delivered via MCP send_message — use last sent message as content fallback
    content = mcpMessages[mcpMessages.length - 1];
  }

  return {
    content,
    tokensUsed: resultLine.usage?.output_tokens || 0,
    sentViaMcp: mcpMessages.length > 0,
    mcpMessages,
    toolCalls,
    inputTokens: resultLine.usage?.input_tokens || 0,
  };
}

export class ClaudeCLIClient implements LLMClient {
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
      getAllowedTools(),
    ];

    if (context) {
      const mcpConfig = JSON.stringify(
        buildMcpConfig(context, { toolNotificationsEnabled: context.toolNotificationsEnabled }),
      );
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

    const systemChars = systemPrompt?.length || 0;
    const promptChars = prompt.length;
    logger.step(`llm: spawning claude -p (max turns: ${this.maxTurns})`);
    logger.step(
      `llm: system prompt ${(systemChars / 1024).toFixed(1)}k chars, conversation ${(promptChars / 1024).toFixed(1)}k chars`,
    );

    try {
      const { stdout } = await spawnPromise('claude', args, {
        timeout: 600000,
        env: { ...process.env, CLAUDECODE: '' },
        onStderr: line => {
          // Log MCP errors and significant stderr output
          if (line.includes('error') || line.includes('Error') || line.includes('fail') || line.includes('WARN')) {
            logger.warn(`claude stderr: ${line.substring(0, 300)}`);
          } else {
            logger.debug(`claude stderr: ${line.substring(0, 300)}`);
          }
        },
      });

      const response = parseClaudeOutput(stdout);

      // Log tool calls, token usage, and delivery method
      if (response.toolCalls.length > 0) {
        logger.step('tools called:');
        for (const tool of response.toolCalls) {
          const toolArgs = tool.input ? JSON.stringify(tool.input).substring(0, 100) : '';
          logger.step(`  ${tool.name}  ${toolArgs}`);
        }
      }
      if (response.inputTokens || response.tokensUsed) {
        logger.step(`llm: ${response.inputTokens} input / ${response.tokensUsed} output tokens`);
      }
      logger.step(`llm: result via ${response.sentViaMcp ? 'MCP send_message' : 'result field'}`);

      return response;
    } catch (error) {
      if (error instanceof Error) {
        // Re-throw our own errors with logging
        if (error.message.startsWith('No result found') || error.message.startsWith('No response content')) {
          logger.error(`Claude CLI produced no usable content: ${error.message}`);
          throw error;
        }
        if (error.message.includes('timed out')) {
          logger.error('Claude CLI timed out after 10 minutes');
          throw new Error('Claude CLI timed out');
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
