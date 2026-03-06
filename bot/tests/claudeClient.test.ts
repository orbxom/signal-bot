import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../src/types';
import { makeMessageContext } from './helpers/fixtures';

const { mockSpawn } = vi.hoisted(() => {
  const mockSpawn = vi.fn();
  return { mockSpawn };
});

vi.mock('child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: mockSpawn,
  };
});

import { ClaudeCLIClient, parseClaudeOutput } from '../src/claudeClient';

function makeResultOutput(result: string, isError = false, usage?: { output_tokens: number }) {
  const initLine = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'test' });
  const resultLine = JSON.stringify({
    type: 'result',
    subtype: isError ? 'error' : 'success',
    is_error: isError,
    result,
    usage,
  });
  return `${initLine}\n${resultLine}`;
}

function createMockChild() {
  const child = Object.assign(new EventEmitter(), {
    stdin: { end: vi.fn() },
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
  });
  return child;
}

function mockSpawnSuccess(stdout: string) {
  mockSpawn.mockImplementation(() => {
    const child = createMockChild();
    process.nextTick(() => {
      child.stdout.emit('data', Buffer.from(stdout));
      child.emit('close', 0);
    });
    return child;
  });
}

function mockSpawnError(errorMessage: string) {
  mockSpawn.mockImplementation(() => {
    const child = createMockChild();
    process.nextTick(() => {
      child.emit('error', new Error(errorMessage));
    });
    return child;
  });
}

function mockSpawnExitCode(code: number, stderr: string) {
  mockSpawn.mockImplementation(() => {
    const child = createMockChild();
    process.nextTick(() => {
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', code);
    });
    return child;
  });
}

describe('ClaudeCLIClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Constructor', () => {
    it('should create client with default maxTurns', () => {
      const client = new ClaudeCLIClient();
      expect(client).toBeDefined();
    });

    it('should create client with custom maxTurns', () => {
      const client = new ClaudeCLIClient(3);
      expect(client).toBeDefined();
    });

    it('should throw error when maxTurns is less than 1', () => {
      expect(() => new ClaudeCLIClient(0)).toThrow('maxTurns must be at least 1');
      expect(() => new ClaudeCLIClient(-1)).toThrow('maxTurns must be at least 1');
    });
  });

  describe('generateResponse', () => {
    it('should throw error when messages array is empty', async () => {
      const client = new ClaudeCLIClient();
      await expect(client.generateResponse([])).rejects.toThrow('Messages array cannot be empty');
    });

    it('should throw error when messages is null', async () => {
      const client = new ClaudeCLIClient();
      await expect(client.generateResponse(null as any)).rejects.toThrow('Messages array cannot be empty');
    });

    it('should call claude with correct args', async () => {
      mockSpawnSuccess(makeResultOutput('Hello!', false, { output_tokens: 10 }));

      const client = new ClaudeCLIClient();
      const messages: ChatMessage[] = [
        { role: 'system', content: 'Be helpful' },
        { role: 'user', content: 'Hi' },
      ];

      await client.generateResponse(messages);

      expect(mockSpawn).toHaveBeenCalledWith(
        'claude',
        expect.arrayContaining([
          '-p',
          'Hi',
          '--output-format',
          'json',
          '--max-turns',
          '1',
          '--no-session-persistence',
          '--system-prompt',
          'Be helpful',
        ]),
        expect.objectContaining({
          env: expect.objectContaining({ CLAUDECODE: '' }),
        }),
      );
    });

    it('should omit --system-prompt when no system message', async () => {
      mockSpawnSuccess(makeResultOutput('Hello!'));

      const client = new ClaudeCLIClient();
      const messages: ChatMessage[] = [{ role: 'user', content: 'Hi' }];

      await client.generateResponse(messages);

      const args = mockSpawn.mock.calls[0][1];
      expect(args).not.toContain('--system-prompt');
    });

    it('should build prompt from conversation history', async () => {
      mockSpawnSuccess(makeResultOutput('Sure!'));

      const client = new ClaudeCLIClient();
      const messages: ChatMessage[] = [
        { role: 'system', content: 'Be helpful' },
        { role: 'user', content: 'Alice: Hello' },
        { role: 'assistant', content: 'Hi there!' },
        { role: 'user', content: 'How are you?' },
      ];

      await client.generateResponse(messages);

      const args = mockSpawn.mock.calls[0][1];
      const promptIdx = args.indexOf('-p') + 1;
      const prompt = args[promptIdx];
      expect(prompt).toContain('Alice: Hello');
      expect(prompt).toContain('Assistant: Hi there!');
      expect(prompt).toContain('How are you?');
    });

    it('should parse JSON output and return content', async () => {
      mockSpawnSuccess(makeResultOutput('Hello from Claude!', false, { output_tokens: 15 }));

      const client = new ClaudeCLIClient();
      const result = await client.generateResponse([{ role: 'user', content: 'Hi' }]);

      expect(result.content).toBe('Hello from Claude!');
      expect(result.tokensUsed).toBe(15);
    });

    it('should default tokensUsed to 0 when usage is missing', async () => {
      mockSpawnSuccess(makeResultOutput('Hello!'));

      const client = new ClaudeCLIClient();
      const result = await client.generateResponse([{ role: 'user', content: 'Hi' }]);

      expect(result.tokensUsed).toBe(0);
    });

    it('should fall back to assistant text when result has is_error', async () => {
      // When result has is_error=true, it falls back to assistant message text
      const output = [
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 'test' }),
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Fallback text' }] },
        }),
        JSON.stringify({
          type: 'result',
          is_error: true,
          result: 'Rate limited',
          subtype: 'error',
        }),
      ].join('\n');
      mockSpawnSuccess(output);

      const client = new ClaudeCLIClient();
      const result = await client.generateResponse([{ role: 'user', content: 'Hi' }]);

      expect(result.content).toBe('Fallback text');
    });

    it('should throw when no result line in output', async () => {
      mockSpawnSuccess(JSON.stringify({ type: 'system', subtype: 'init' }));

      const client = new ClaudeCLIClient();
      await expect(client.generateResponse([{ role: 'user', content: 'Hi' }])).rejects.toThrow(
        'No result found in Claude CLI output',
      );
    });

    it('should throw when Claude CLI is not found', async () => {
      mockSpawnError('spawn claude ENOENT');

      const client = new ClaudeCLIClient();
      await expect(client.generateResponse([{ role: 'user', content: 'Hi' }])).rejects.toThrow('Claude CLI not found');
    });

    it('should throw on non-zero exit with stderr', async () => {
      mockSpawnExitCode(1, 'something went wrong');

      const client = new ClaudeCLIClient();
      await expect(client.generateResponse([{ role: 'user', content: 'Hi' }])).rejects.toThrow('something went wrong');
    });

    it('should wrap unknown errors', async () => {
      mockSpawnError('Something unexpected');

      const client = new ClaudeCLIClient();
      await expect(client.generateResponse([{ role: 'user', content: 'Hi' }])).rejects.toThrow(
        'Failed to generate response from Claude CLI: Something unexpected',
      );
    });

    it('should use custom maxTurns', async () => {
      mockSpawnSuccess(makeResultOutput('Done!'));

      const client = new ClaudeCLIClient(3);
      await client.generateResponse([{ role: 'user', content: 'Hi' }]);

      const args = mockSpawn.mock.calls[0][1];
      const maxTurnsIdx = args.indexOf('--max-turns') + 1;
      expect(args[maxTurnsIdx]).toBe('3');
    });

    it('should include MCP config when context is provided', async () => {
      mockSpawnSuccess(makeResultOutput('Reminder set!'));

      const client = new ClaudeCLIClient();
      const messages: ChatMessage[] = [{ role: 'user', content: 'Remind me' }];
      const context = makeMessageContext({
        groupId: 'test-group',
        sender: '+61400000000',
        dbPath: '/tmp/test.db',
        githubRepo: 'owner/repo',
        sourceRoot: '/tmp/src',
        signalCliUrl: 'http://localhost:8080',
        botPhoneNumber: '+61400000000',
      });

      await client.generateResponse(messages, context);

      const args = mockSpawn.mock.calls[0][1];
      expect(args).toContain('--mcp-config');
      expect(args).toContain('--strict-mcp-config');

      const mcpConfigIdx = args.indexOf('--mcp-config') + 1;
      const mcpConfig = JSON.parse(args[mcpConfigIdx]);
      expect(mcpConfig.mcpServers.reminders).toBeDefined();
      expect(['node', 'npx']).toContain(mcpConfig.mcpServers.reminders.command);
      expect(mcpConfig.mcpServers.reminders.env.MCP_GROUP_ID).toBe('test-group');
      expect(mcpConfig.mcpServers.reminders.env.MCP_SENDER).toBe('+61400000000');
      expect(mcpConfig.mcpServers.reminders.env.DB_PATH).toBe('/tmp/test.db');
      expect(mcpConfig.mcpServers.reminders.env.TZ).toBe('Australia/Sydney');

      expect(mcpConfig.mcpServers.github).toBeDefined();
      expect(['node', 'npx']).toContain(mcpConfig.mcpServers.github.command);
      expect(mcpConfig.mcpServers.github.env.GITHUB_REPO).toBe('owner/repo');
      expect(mcpConfig.mcpServers.github.env.MCP_SENDER).toBe('+61400000000');
    });

    it('should include signal MCP server in config when context is provided', async () => {
      mockSpawnSuccess(makeResultOutput('Sent!'));

      const client = new ClaudeCLIClient();
      const messages: ChatMessage[] = [{ role: 'user', content: 'Hello' }];
      const context = makeMessageContext({
        groupId: 'test-group',
        sender: '+61400000000',
        dbPath: '/tmp/test.db',
        githubRepo: 'owner/repo',
        sourceRoot: '/tmp/src',
        signalCliUrl: 'http://localhost:8080',
        botPhoneNumber: '+61400000000',
      });

      await client.generateResponse(messages, context);

      const args = mockSpawn.mock.calls[0][1];
      const mcpConfigIdx = args.indexOf('--mcp-config') + 1;
      const mcpConfig = JSON.parse(args[mcpConfigIdx]);

      expect(mcpConfig.mcpServers.signal).toBeDefined();
      expect(['node', 'npx']).toContain(mcpConfig.mcpServers.signal.command);
      expect(mcpConfig.mcpServers.signal.env.SIGNAL_CLI_URL).toBe('http://localhost:8080');
      expect(mcpConfig.mcpServers.signal.env.SIGNAL_ACCOUNT).toBe('+61400000000');
      expect(mcpConfig.mcpServers.signal.env.MCP_GROUP_ID).toBe('test-group');
    });

    it('should not include MCP config when context is not provided', async () => {
      mockSpawnSuccess(makeResultOutput('Hello!'));

      const client = new ClaudeCLIClient();
      await client.generateResponse([{ role: 'user', content: 'Hi' }]);

      const args = mockSpawn.mock.calls[0][1];
      expect(args).not.toContain('--mcp-config');
      expect(args).not.toContain('--strict-mcp-config');
    });

    it('should include dossier tools in allowed tools', async () => {
      mockSpawnSuccess(makeResultOutput('Done!'));

      const client = new ClaudeCLIClient();
      await client.generateResponse([{ role: 'user', content: 'Hi' }]);

      const args = mockSpawn.mock.calls[0][1];
      const allowedToolsIdx = args.indexOf('--allowedTools') + 1;
      const allowedTools = args[allowedToolsIdx];

      expect(allowedTools).toContain('mcp__dossiers__update_dossier');
      expect(allowedTools).toContain('mcp__dossiers__get_dossier');
      expect(allowedTools).toContain('mcp__dossiers__list_dossiers');
    });

    it('should include Agent in allowed tools', async () => {
      mockSpawnSuccess(makeResultOutput('Done!'));

      const client = new ClaudeCLIClient();
      await client.generateResponse([{ role: 'user', content: 'Hi' }]);

      const args = mockSpawn.mock.calls[0][1];
      const allowedToolsIdx = args.indexOf('--allowedTools') + 1;
      const allowedTools = args[allowedToolsIdx];

      expect(allowedTools).toContain('Agent');
    });

    it('should include history MCP tools in allowed tools', async () => {
      mockSpawnSuccess(makeResultOutput('Done!'));

      const client = new ClaudeCLIClient();
      await client.generateResponse([{ role: 'user', content: 'Hi' }]);

      const args = mockSpawn.mock.calls[0][1];
      const allowedToolsIdx = args.indexOf('--allowedTools') + 1;
      const allowedTools = args[allowedToolsIdx];

      expect(allowedTools).toContain('mcp__history__search_messages');
      expect(allowedTools).toContain('mcp__history__get_messages_by_date');
    });

    it('should include --agents flag with message-historian when context is provided', async () => {
      mockSpawnSuccess(makeResultOutput('Found it!'));

      const client = new ClaudeCLIClient();
      const messages: ChatMessage[] = [{ role: 'user', content: 'What did we talk about yesterday?' }];
      const context = makeMessageContext({
        groupId: 'test-group',
        sender: '+61400000000',
        dbPath: '/tmp/test.db',
        githubRepo: 'owner/repo',
        sourceRoot: '/tmp/src',
        signalCliUrl: 'http://localhost:8080',
        botPhoneNumber: '+61400000000',
      });

      await client.generateResponse(messages, context);

      const args = mockSpawn.mock.calls[0][1];
      expect(args).toContain('--agents');

      const agentsIdx = args.indexOf('--agents') + 1;
      const agentsConfig = JSON.parse(args[agentsIdx]);
      expect(agentsConfig['message-historian']).toBeDefined();
      expect(agentsConfig['message-historian'].model).toBe('haiku');
      expect(agentsConfig['message-historian'].tools).toContain('mcp__history__search_messages');
      expect(agentsConfig['message-historian'].tools).toContain('mcp__history__get_messages_by_date');
      expect(agentsConfig['message-historian'].prompt).toContain('Australia/Sydney');
    });

    it('should not include --agents flag when context is not provided', async () => {
      mockSpawnSuccess(makeResultOutput('Hello!'));

      const client = new ClaudeCLIClient();
      await client.generateResponse([{ role: 'user', content: 'Hi' }]);

      const args = mockSpawn.mock.calls[0][1];
      expect(args).not.toContain('--agents');
    });

    it('should include history MCP server in config when context is provided', async () => {
      mockSpawnSuccess(makeResultOutput('History!'));

      const client = new ClaudeCLIClient();
      const messages: ChatMessage[] = [{ role: 'user', content: 'Search history' }];
      const context = makeMessageContext({
        groupId: 'test-group',
        sender: '+61400000000',
        dbPath: '/tmp/test.db',
        githubRepo: 'owner/repo',
        sourceRoot: '/tmp/src',
        signalCliUrl: 'http://localhost:8080',
        botPhoneNumber: '+61400000000',
      });

      await client.generateResponse(messages, context);

      const args = mockSpawn.mock.calls[0][1];
      const mcpConfigIdx = args.indexOf('--mcp-config') + 1;
      const mcpConfig = JSON.parse(args[mcpConfigIdx]);

      expect(mcpConfig.mcpServers.history).toBeDefined();
      expect(['node', 'npx']).toContain(mcpConfig.mcpServers.history.command);
      expect(mcpConfig.mcpServers.history.env.DB_PATH).toBe('/tmp/test.db');
      expect(mcpConfig.mcpServers.history.env.MCP_GROUP_ID).toBe('test-group');
      expect(mcpConfig.mcpServers.history.env.TZ).toBe('Australia/Sydney');
    });

    it('should include dossier MCP server in config when context is provided', async () => {
      mockSpawnSuccess(makeResultOutput('Updated!'));

      const client = new ClaudeCLIClient();
      const messages: ChatMessage[] = [{ role: 'user', content: 'Remember this' }];
      const context = makeMessageContext({
        groupId: 'test-group',
        sender: '+61400000000',
        dbPath: '/tmp/test.db',
        githubRepo: 'owner/repo',
        sourceRoot: '/tmp/src',
        signalCliUrl: 'http://localhost:8080',
        botPhoneNumber: '+61400000000',
      });

      await client.generateResponse(messages, context);

      const args = mockSpawn.mock.calls[0][1];
      const mcpConfigIdx = args.indexOf('--mcp-config') + 1;
      const mcpConfig = JSON.parse(args[mcpConfigIdx]);

      expect(mcpConfig.mcpServers.dossiers).toBeDefined();
      expect(['node', 'npx']).toContain(mcpConfig.mcpServers.dossiers.command);
      expect(mcpConfig.mcpServers.dossiers.env.DB_PATH).toBe('/tmp/test.db');
      expect(mcpConfig.mcpServers.dossiers.env.MCP_GROUP_ID).toBe('test-group');
      expect(mcpConfig.mcpServers.dossiers.env.MCP_SENDER).toBeUndefined();
    });

    it('should detect when messages were sent via MCP signal tool', async () => {
      const output = [
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 'test' }),
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                name: 'mcp__signal__send_message',
                input: { message: 'Looking into it...' },
              },
            ],
          },
        }),
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                name: 'mcp__signal__send_message',
                input: { message: 'Here is the answer!' },
              },
            ],
          },
        }),
        JSON.stringify({
          type: 'result',
          is_error: false,
          result: 'Here is the answer!',
          usage: { output_tokens: 20 },
        }),
      ].join('\n');
      mockSpawnSuccess(output);

      const client = new ClaudeCLIClient();
      const result = await client.generateResponse([{ role: 'user', content: 'Hi' }]);

      expect(result.sentViaMcp).toBe(true);
      expect(result.mcpMessages).toEqual(['Looking into it...', 'Here is the answer!']);
    });

    it('should succeed when MCP messages sent but result has no text content', async () => {
      const output = [
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 'test' }),
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                name: 'mcp__signal__send_message',
                input: { message: 'Here is the answer!' },
              },
            ],
          },
        }),
        JSON.stringify({
          type: 'result',
          is_error: false,
          result: '',
          usage: { output_tokens: 10 },
        }),
      ].join('\n');
      mockSpawnSuccess(output);

      const client = new ClaudeCLIClient();
      const result = await client.generateResponse([{ role: 'user', content: 'Hi' }]);

      expect(result.sentViaMcp).toBe(true);
      expect(result.mcpMessages).toEqual(['Here is the answer!']);
      expect(result.content).toBe('Here is the answer!');
    });

    it('should set sentViaMcp to false when no signal tool calls', async () => {
      mockSpawnSuccess(makeResultOutput('Simple response'));

      const client = new ClaudeCLIClient();
      const result = await client.generateResponse([{ role: 'user', content: 'Hi' }]);

      expect(result.sentViaMcp).toBe(false);
      expect(result.mcpMessages).toEqual([]);
    });

    it('should include transcription MCP server in config when context is provided', async () => {
      mockSpawnSuccess(makeResultOutput('Transcribed!'));

      const client = new ClaudeCLIClient();
      const messages: ChatMessage[] = [{ role: 'user', content: 'Transcribe this' }];
      const context = makeMessageContext({
        groupId: 'test-group',
        sender: '+61400000000',
        dbPath: '/tmp/test.db',
        githubRepo: 'owner/repo',
        sourceRoot: '/app/source',
        signalCliUrl: 'http://localhost:8080',
        botPhoneNumber: '+61400000000',
        attachmentsDir: '/app/signal-attachments',
        whisperModelPath: '/models/ggml-large.bin',
      });

      await client.generateResponse(messages, context);

      const args = mockSpawn.mock.calls[0][1];
      const mcpConfigIdx = args.indexOf('--mcp-config') + 1;
      const mcpConfig = JSON.parse(args[mcpConfigIdx]);

      expect(mcpConfig.mcpServers.transcription).toBeDefined();
      expect(mcpConfig.mcpServers.transcription.env.WHISPER_MODEL_PATH).toBe('/models/ggml-large.bin');
      expect(mcpConfig.mcpServers.transcription.env.ATTACHMENTS_DIR).toBe('/app/signal-attachments');
    });

    it('should include transcription tool in allowed tools', async () => {
      mockSpawnSuccess(makeResultOutput('Done!'));

      const client = new ClaudeCLIClient();
      await client.generateResponse([{ role: 'user', content: 'Hi' }]);

      const args = mockSpawn.mock.calls[0][1];
      const allowedToolsIdx = args.indexOf('--allowedTools') + 1;
      const allowedTools = args[allowedToolsIdx];

      expect(allowedTools).toContain('mcp__transcription__transcribe_audio');
    });

    it('should parse JSON array output format', async () => {
      const output = JSON.stringify([
        { type: 'system', subtype: 'init', session_id: 'test' },
        { type: 'result', is_error: false, result: 'Array format!', usage: { output_tokens: 5 } },
      ]);
      mockSpawnSuccess(output);

      const client = new ClaudeCLIClient();
      const result = await client.generateResponse([{ role: 'user', content: 'Hi' }]);

      expect(result.content).toBe('Array format!');
    });

    it('should include persona MCP tools in allowed tools', async () => {
      mockSpawnSuccess(makeResultOutput('Done!'));

      const client = new ClaudeCLIClient();
      await client.generateResponse([{ role: 'user', content: 'Hi' }]);

      const args = mockSpawn.mock.calls[0][1];
      const allowedToolsIdx = args.indexOf('--allowedTools') + 1;
      const allowedTools = args[allowedToolsIdx];

      expect(allowedTools).toContain('mcp__personas__create_persona');
      expect(allowedTools).toContain('mcp__personas__get_persona');
      expect(allowedTools).toContain('mcp__personas__list_personas');
      expect(allowedTools).toContain('mcp__personas__update_persona');
      expect(allowedTools).toContain('mcp__personas__delete_persona');
      expect(allowedTools).toContain('mcp__personas__switch_persona');
    });

    it('should include persona MCP server in config when context is provided', async () => {
      mockSpawnSuccess(makeResultOutput('Switched!'));

      const client = new ClaudeCLIClient();
      const messages: ChatMessage[] = [{ role: 'user', content: 'Switch persona' }];
      const context = makeMessageContext({
        groupId: 'test-group',
        sender: '+61400000000',
        dbPath: '/tmp/test.db',
        githubRepo: 'owner/repo',
        sourceRoot: '/tmp/src',
        signalCliUrl: 'http://localhost:8080',
        botPhoneNumber: '+61400000000',
        attachmentsDir: '/app/signal-attachments',
        whisperModelPath: '/models/ggml-large.bin',
      });

      await client.generateResponse(messages, context);

      const args = mockSpawn.mock.calls[0][1];
      const mcpConfigIdx = args.indexOf('--mcp-config') + 1;
      const mcpConfig = JSON.parse(args[mcpConfigIdx]);

      expect(mcpConfig.mcpServers.personas).toBeDefined();
      expect(['node', 'npx']).toContain(mcpConfig.mcpServers.personas.command);
      expect(mcpConfig.mcpServers.personas.env.DB_PATH).toBe('/tmp/test.db');
      expect(mcpConfig.mcpServers.personas.env.MCP_GROUP_ID).toBe('test-group');
      expect(mcpConfig.mcpServers.personas.env.MCP_SENDER).toBe('+61400000000');
    });

    it('should include send_image in allowed tools', async () => {
      mockSpawnSuccess(makeResultOutput('Done!'));

      const client = new ClaudeCLIClient();
      await client.generateResponse([{ role: 'user', content: 'Hi' }]);

      const args = mockSpawn.mock.calls[0][1];
      const allowedToolsIdx = args.indexOf('--allowedTools') + 1;
      const allowedTools = args[allowedToolsIdx];

      expect(allowedTools).toContain('mcp__signal__send_image');
    });

    it('should detect send_image MCP tool calls as sentViaMcp', async () => {
      const output = [
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 'test' }),
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                name: 'mcp__signal__send_image',
                input: { imagePath: '/tmp/screenshot.png', caption: 'Here is the page' },
              },
            ],
          },
        }),
        JSON.stringify({
          type: 'result',
          is_error: false,
          result: '',
          usage: { output_tokens: 15 },
        }),
      ].join('\n');
      mockSpawnSuccess(output);

      const client = new ClaudeCLIClient();
      const result = await client.generateResponse([{ role: 'user', content: 'Screenshot this' }]);

      expect(result.sentViaMcp).toBe(true);
      expect(result.mcpMessages).toContain('[sent an image: Here is the page]');
    });

    it('should detect send_image without caption as generic placeholder', async () => {
      const output = [
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 'test' }),
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                name: 'mcp__signal__send_image',
                input: { imagePath: '/tmp/screenshot.png' },
              },
            ],
          },
        }),
        JSON.stringify({
          type: 'result',
          is_error: false,
          result: '',
          usage: { output_tokens: 10 },
        }),
      ].join('\n');
      mockSpawnSuccess(output);

      const client = new ClaudeCLIClient();
      const result = await client.generateResponse([{ role: 'user', content: 'Screenshot' }]);

      expect(result.sentViaMcp).toBe(true);
      expect(result.mcpMessages).toContain('[sent an image]');
    });

    it('should include playwright MCP tools in allowed tools', async () => {
      mockSpawnSuccess(makeResultOutput('Done!'));

      const client = new ClaudeCLIClient();
      await client.generateResponse([{ role: 'user', content: 'Hi' }]);

      const args = mockSpawn.mock.calls[0][1];
      const allowedToolsIdx = args.indexOf('--allowedTools') + 1;
      const allowedTools = args[allowedToolsIdx];

      expect(allowedTools).toContain('mcp__playwright__browser_navigate');
      expect(allowedTools).toContain('mcp__playwright__browser_snapshot');
      expect(allowedTools).toContain('mcp__playwright__browser_take_screenshot');
      expect(allowedTools).toContain('mcp__playwright__browser_click');
      expect(allowedTools).toContain('mcp__playwright__browser_type');
      expect(allowedTools).toContain('mcp__playwright__browser_close');
    });

    it('should include playwright MCP server in config when context is provided', async () => {
      mockSpawnSuccess(makeResultOutput('Browsed!'));

      const client = new ClaudeCLIClient();
      const messages: ChatMessage[] = [{ role: 'user', content: 'Browse web' }];
      const context = makeMessageContext({
        groupId: 'test-group',
        sender: '+61400000000',
        dbPath: '/tmp/test.db',
        githubRepo: 'owner/repo',
        sourceRoot: '/tmp/src',
        signalCliUrl: 'http://localhost:8080',
        botPhoneNumber: '+61400000000',
        attachmentsDir: '/app/signal-attachments',
        whisperModelPath: '/models/ggml-large.bin',
      });

      await client.generateResponse(messages, context);

      const args = mockSpawn.mock.calls[0][1];
      const mcpConfigIdx = args.indexOf('--mcp-config') + 1;
      const mcpConfig = JSON.parse(args[mcpConfigIdx]);

      expect(mcpConfig.mcpServers.playwright).toBeDefined();
      expect(mcpConfig.mcpServers.playwright.command).toBe('npx');
      expect(mcpConfig.mcpServers.playwright.args).toContain('--headless');
    });
  });

  describe('parseClaudeOutput', () => {
    it('should parse NDJSON output with result line', () => {
      const output = makeResultOutput('Hello!', false, { output_tokens: 10 });
      const result = parseClaudeOutput(output);
      expect(result.content).toBe('Hello!');
      expect(result.tokensUsed).toBe(10);
      expect(result.sentViaMcp).toBe(false);
    });

    it('should parse JSON array output', () => {
      const output = JSON.stringify([
        { type: 'system', subtype: 'init', session_id: 'test' },
        { type: 'result', is_error: false, result: 'Array!', usage: { output_tokens: 5 } },
      ]);
      const result = parseClaudeOutput(output);
      expect(result.content).toBe('Array!');
    });

    it('should throw when no result line found', () => {
      const output = JSON.stringify({ type: 'system', subtype: 'init' });
      expect(() => parseClaudeOutput(output)).toThrow('No result found in Claude CLI output');
    });

    it('should detect MCP send_message tool calls', () => {
      const output = [
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 'test' }),
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', name: 'mcp__signal__send_message', input: { message: 'Hi there' } }],
          },
        }),
        JSON.stringify({ type: 'result', is_error: false, result: 'Hi there', usage: { output_tokens: 5 } }),
      ].join('\n');
      const result = parseClaudeOutput(output);
      expect(result.sentViaMcp).toBe(true);
      expect(result.mcpMessages).toEqual(['Hi there']);
    });

    it('should fall back to assistant text when result has is_error', () => {
      const output = [
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 'test' }),
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Fallback text' }] },
        }),
        JSON.stringify({ type: 'result', is_error: true, result: 'Rate limited', subtype: 'error' }),
      ].join('\n');
      const result = parseClaudeOutput(output);
      expect(result.content).toBe('Fallback text');
    });
  });
});
