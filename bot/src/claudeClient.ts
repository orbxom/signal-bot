import { spawn } from 'node:child_process';
import { buildAllowedTools, buildMcpConfig } from './mcp/registry';
import { getErrorMessage } from './mcp/result';
import type { ChatMessage, LLMClient, LLMResponse, MessageContext } from './types';

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

/** Parse raw Claude CLI stdout into a structured LLMResponse. */
export function parseClaudeOutput(stdout: string): LLMResponse {
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

  // Single pass: find result line, last assistant entry, and MCP send_message calls
  let resultLine: ClaudeResultLine | undefined;
  let lastAssistant: { message?: { content?: Array<{ type: string; text?: string }> } } | undefined;
  const mcpMessages: string[] = [];
  for (const e of entries) {
    if (e.type === 'result') resultLine = e as unknown as ClaudeResultLine;
    if (e.type === 'assistant') lastAssistant = e as unknown as typeof lastAssistant;

    // Detect send_message and send_image MCP tool calls
    if (e.type === 'assistant') {
      const msg = e as unknown as {
        message?: {
          content?: Array<{ type: string; name?: string; input?: Record<string, unknown> }>;
        };
      };
      for (const block of msg.message?.content || []) {
        if (block.type === 'tool_use' && block.name === 'mcp__signal__send_message' && block.input?.message) {
          mcpMessages.push(block.input.message as string);
        }
        if (block.type === 'tool_use' && block.name === 'mcp__signal__send_image') {
          const caption = block.input?.caption as string | undefined;
          mcpMessages.push(caption ? `[sent an image: ${caption}]` : '[sent an image]');
        }
      }
    }
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
    if (mcpMessages.length === 0) {
      console.error('[Claude] No content found. Full output:', JSON.stringify(entries, null, 2).substring(0, 2000));
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
      const mcpConfig = JSON.stringify(buildMcpConfig(context));
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
        timeout: 300000,
        env: { ...process.env, CLAUDECODE: '' },
      });

      return parseClaudeOutput(stdout);
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
