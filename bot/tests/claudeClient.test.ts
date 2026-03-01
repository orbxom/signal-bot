import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatMessage } from '../src/types';

const { mockExecFile } = vi.hoisted(() => {
  const mockExecFile = vi.fn();
  return { mockExecFile };
});

vi.mock('child_process', () => ({
  execFile: mockExecFile,
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

function mockExecFileSuccess(stdout: string) {
  mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: object, cb: Function) => {
    cb(null, stdout, '');
  });
}

function mockExecFileError(error: Error) {
  mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: object, cb: Function) => {
    cb(error, '', '');
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
      mockExecFileSuccess(makeResultOutput('Hello!', false, { output_tokens: 10 }));

      const client = new ClaudeCLIClient();
      const messages: ChatMessage[] = [
        { role: 'system', content: 'Be helpful' },
        { role: 'user', content: 'Hi' },
      ];

      await client.generateResponse(messages);

      expect(mockExecFile).toHaveBeenCalledWith(
        'claude',
        expect.arrayContaining([
          '-p', 'Hi',
          '--output-format', 'json',
          '--max-turns', '1',
          '--no-session-persistence',
          '--system-prompt', 'Be helpful',
        ]),
        expect.objectContaining({
          timeout: 120000,
          env: expect.objectContaining({ CLAUDECODE: '' }),
        }),
        expect.any(Function)
      );
    });

    it('should omit --system-prompt when no system message', async () => {
      mockExecFileSuccess(makeResultOutput('Hello!'));

      const client = new ClaudeCLIClient();
      const messages: ChatMessage[] = [
        { role: 'user', content: 'Hi' },
      ];

      await client.generateResponse(messages);

      const args = mockExecFile.mock.calls[0][1];
      expect(args).not.toContain('--system-prompt');
    });

    it('should build prompt from conversation history', async () => {
      mockExecFileSuccess(makeResultOutput('Sure!'));

      const client = new ClaudeCLIClient();
      const messages: ChatMessage[] = [
        { role: 'system', content: 'Be helpful' },
        { role: 'user', content: 'Alice: Hello' },
        { role: 'assistant', content: 'Hi there!' },
        { role: 'user', content: 'How are you?' },
      ];

      await client.generateResponse(messages);

      const args = mockExecFile.mock.calls[0][1];
      const promptIdx = args.indexOf('-p') + 1;
      const prompt = args[promptIdx];
      expect(prompt).toContain('Alice: Hello');
      expect(prompt).toContain('Assistant: Hi there!');
      expect(prompt).toContain('How are you?');
    });

    it('should parse JSON output and return content', async () => {
      mockExecFileSuccess(makeResultOutput('Hello from Claude!', false, { output_tokens: 15 }));

      const client = new ClaudeCLIClient();
      const result = await client.generateResponse([{ role: 'user', content: 'Hi' }]);

      expect(result.content).toBe('Hello from Claude!');
      expect(result.tokensUsed).toBe(15);
    });

    it('should default tokensUsed to 0 when usage is missing', async () => {
      mockExecFileSuccess(makeResultOutput('Hello!'));

      const client = new ClaudeCLIClient();
      const result = await client.generateResponse([{ role: 'user', content: 'Hi' }]);

      expect(result.tokensUsed).toBe(0);
    });

    it('should throw when Claude CLI returns an error result', async () => {
      mockExecFileSuccess(makeResultOutput('Rate limited', true));

      const client = new ClaudeCLIClient();
      await expect(client.generateResponse([{ role: 'user', content: 'Hi' }]))
        .rejects.toThrow('Claude CLI returned error: Rate limited');
    });

    it('should throw when no result line in output', async () => {
      mockExecFileSuccess(JSON.stringify({ type: 'system', subtype: 'init' }));

      const client = new ClaudeCLIClient();
      await expect(client.generateResponse([{ role: 'user', content: 'Hi' }]))
        .rejects.toThrow('No result found in Claude CLI output');
    });

    it('should throw when Claude CLI is not found', async () => {
      mockExecFileError(new Error('spawn claude ENOENT'));

      const client = new ClaudeCLIClient();
      await expect(client.generateResponse([{ role: 'user', content: 'Hi' }]))
        .rejects.toThrow('Claude CLI not found');
    });

    it('should throw on timeout', async () => {
      mockExecFileError(new Error('process killed'));

      const client = new ClaudeCLIClient();
      await expect(client.generateResponse([{ role: 'user', content: 'Hi' }]))
        .rejects.toThrow('Claude CLI timed out');
    });

    it('should wrap unknown errors', async () => {
      mockExecFileError(new Error('Something unexpected'));

      const client = new ClaudeCLIClient();
      await expect(client.generateResponse([{ role: 'user', content: 'Hi' }]))
        .rejects.toThrow('Failed to generate response from Claude CLI: Something unexpected');
    });

    it('should use custom maxTurns', async () => {
      mockExecFileSuccess(makeResultOutput('Done!'));

      const client = new ClaudeCLIClient(3);
      await client.generateResponse([{ role: 'user', content: 'Hi' }]);

      const args = mockExecFile.mock.calls[0][1];
      const maxTurnsIdx = args.indexOf('--max-turns') + 1;
      expect(args[maxTurnsIdx]).toBe('3');
    });
  });
});
