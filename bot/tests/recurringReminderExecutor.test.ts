import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecurringReminder } from '../src/types';

const { mockSpawnPromise } = vi.hoisted(() => {
  const mockSpawnPromise = vi.fn();
  return { mockSpawnPromise };
});

vi.mock('../src/claudeClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/claudeClient')>();
  return {
    ...actual,
    spawnPromise: mockSpawnPromise,
  };
});

vi.mock('../src/logger', () => ({
  logger: {
    step: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

import { RecurringReminderExecutor } from '../src/recurringReminderExecutor';

function makeReminder(overrides?: Partial<RecurringReminder>): RecurringReminder {
  return {
    id: 1,
    groupId: 'test-group-123',
    requester: '+61400111222',
    promptText: 'Good morning! Give a brief weather update.',
    cronExpression: '0 8 * * *',
    timezone: 'Australia/Sydney',
    nextDueAt: Date.now(),
    status: 'active',
    consecutiveFailures: 0,
    lastFiredAt: null,
    lastInFlightAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeMcpSendOutput() {
  return JSON.stringify([
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'mcp__signal__send_message', input: { message: 'Good morning!' } },
        ],
      },
    },
    { type: 'result', result: 'Good morning!', is_error: false, usage: { input_tokens: 100, output_tokens: 50 } },
  ]);
}

function makeDirectOutput() {
  return JSON.stringify([
    {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'Good morning everyone!' }],
      },
    },
    { type: 'result', result: 'Good morning everyone!', is_error: false, usage: { input_tokens: 80, output_tokens: 30 } },
  ]);
}

describe('RecurringReminderExecutor', () => {
  let executor: RecurringReminderExecutor;
  let mockSignalClient: { sendMessage: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    mockSpawnPromise.mockResolvedValue({ stdout: makeMcpSendOutput() });
    mockSignalClient = { sendMessage: vi.fn().mockResolvedValue(undefined) };
    executor = new RecurringReminderExecutor(
      {
        dbPath: '/tmp/test.db',
        timezone: 'Australia/Sydney',
        githubRepo: 'owner/repo',
        sourceRoot: '/tmp/src',
        signalCliUrl: 'http://localhost:8080',
        botPhoneNumber: '+61400000000',
        attachmentsDir: '/tmp/attachments',
        whisperModelPath: '/tmp/model.bin',
      },
      mockSignalClient as any,
      10,
    );
  });

  it('should call spawnPromise when executing a reminder', async () => {
    const reminder = makeReminder();
    await executor.execute(reminder);

    expect(mockSpawnPromise).toHaveBeenCalledOnce();
    expect(mockSpawnPromise).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining(['-p', reminder.promptText, '--output-format', 'json']),
      expect.objectContaining({ timeout: 300000 }),
    );
  });

  it('should send result via signalClient when Claude does NOT use MCP send_message', async () => {
    mockSpawnPromise.mockResolvedValue({ stdout: makeDirectOutput() });

    const reminder = makeReminder();
    await executor.execute(reminder);

    expect(mockSignalClient.sendMessage).toHaveBeenCalledOnce();
    expect(mockSignalClient.sendMessage).toHaveBeenCalledWith('test-group-123', 'Good morning everyone!');
  });

  it('should NOT send via signalClient when Claude used MCP send_message', async () => {
    const reminder = makeReminder();
    await executor.execute(reminder);

    expect(mockSignalClient.sendMessage).not.toHaveBeenCalled();
  });

  it('should pass --system-prompt and --agents flags', async () => {
    const reminder = makeReminder();
    await executor.execute(reminder);

    const args = mockSpawnPromise.mock.calls[0][1] as string[];
    expect(args).toContain('--system-prompt');
    expect(args).toContain('--agents');

    const systemIdx = args.indexOf('--system-prompt') + 1;
    const systemPrompt = args[systemIdx];
    expect(systemPrompt).toContain('recurring reminder');
    expect(systemPrompt).toContain(reminder.timezone);
    expect(systemPrompt).toContain(reminder.groupId);

    const agentsIdx = args.indexOf('--agents') + 1;
    const agentsConfig = JSON.parse(args[agentsIdx]);
    expect(agentsConfig['message-historian']).toBeDefined();
    expect(agentsConfig['message-historian'].model).toBe('haiku');
  });

  it('should pass --max-turns with configured value', async () => {
    const reminder = makeReminder();
    await executor.execute(reminder);

    const args = mockSpawnPromise.mock.calls[0][1] as string[];
    const maxTurnsIdx = args.indexOf('--max-turns') + 1;
    expect(args[maxTurnsIdx]).toBe('10');
  });

  it('should pass --mcp-config and --strict-mcp-config', async () => {
    const reminder = makeReminder();
    await executor.execute(reminder);

    const args = mockSpawnPromise.mock.calls[0][1] as string[];
    expect(args).toContain('--mcp-config');
    expect(args).toContain('--strict-mcp-config');
  });
});
