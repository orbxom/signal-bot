import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../src/types';

const { mockSpawn } = vi.hoisted(() => {
  const mockSpawn = vi.fn();
  return { mockSpawn };
});

vi.mock('child_process', () => ({
  spawn: mockSpawn,
}));

import { ClaudeCLIClient } from '../src/claudeClient';

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
      const context = {
        groupId: 'test-group',
        sender: '+61400000000',
        dbPath: '/tmp/test.db',
        timezone: 'Australia/Sydney',
        githubRepo: 'owner/repo',
      };

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

    it('should include dossier MCP server in config when context is provided', async () => {
      mockSpawnSuccess(makeResultOutput('Updated!'));

      const client = new ClaudeCLIClient();
      const messages: ChatMessage[] = [{ role: 'user', content: 'Remember this' }];
      const context = {
        groupId: 'test-group',
        sender: '+61400000000',
        dbPath: '/tmp/test.db',
        timezone: 'Australia/Sydney',
        githubRepo: 'owner/repo',
      };

      await client.generateResponse(messages, context);

      const args = mockSpawn.mock.calls[0][1];
      const mcpConfigIdx = args.indexOf('--mcp-config') + 1;
      const mcpConfig = JSON.parse(args[mcpConfigIdx]);

      expect(mcpConfig.mcpServers.dossiers).toBeDefined();
      expect(['node', 'npx']).toContain(mcpConfig.mcpServers.dossiers.command);
      expect(mcpConfig.mcpServers.dossiers.env.DB_PATH).toBe('/tmp/test.db');
      expect(mcpConfig.mcpServers.dossiers.env.MCP_GROUP_ID).toBe('test-group');
      expect(mcpConfig.mcpServers.dossiers.env.MCP_SENDER).toBe('+61400000000');
    });

    it('should include transcription MCP server in config when context is provided', async () => {
      mockSpawnSuccess(makeResultOutput('Transcribed!'));

      const client = new ClaudeCLIClient();
      const messages: ChatMessage[] = [{ role: 'user', content: 'Transcribe this' }];
      const context = {
        groupId: 'test-group',
        sender: '+61400000000',
        dbPath: '/tmp/test.db',
        timezone: 'Australia/Sydney',
        githubRepo: 'owner/repo',
        sourceRoot: '/app/source',
        attachmentsDir: '/app/signal-attachments',
        whisperModelPath: '/models/ggml-large.bin',
      };

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
  });
});
