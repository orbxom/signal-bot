import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageHandler } from '../src/messageHandler';
import type { SignalClient } from '../src/signalClient';
import type { Storage } from '../src/storage';
import type { AppConfig, ExtractedMessage, LLMClient } from '../src/types';

vi.mock('../src/logger', () => ({
  logger: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    group: vi.fn(),
    step: vi.fn(),
    groupEnd: vi.fn(),
    compact: vi.fn(),
  },
}));

function makeAppConfig(overrides?: Partial<AppConfig>): AppConfig {
  return {
    dbPath: './data/bot.db',
    timezone: 'Australia/Sydney',
    githubRepo: '',
    sourceRoot: '',
    signalCliUrl: '',
    botPhoneNumber: '+1234567890',
    attachmentsDir: './data/signal-attachments',
    whisperModelPath: './models/ggml-base.en.bin',
    darkFactoryEnabled: '',
    darkFactoryProjectRoot: '',
    ...overrides,
  };
}

function makeMessage(overrides: Partial<ExtractedMessage> & { content: string }): ExtractedMessage {
  return {
    sender: '+61400111222',
    groupId: 'g1',
    timestamp: Date.now() - 60000,
    attachments: [],
    ...overrides,
  };
}

describe('MessageHandler.handleMessageBatch', () => {
  let mockStorage: Storage;
  let mockLLM: LLMClient;
  let mockSignal: SignalClient;
  let handler: MessageHandler;

  beforeEach(() => {
    vi.clearAllMocks();

    mockStorage = {
      addMessage: vi.fn(),
      getRecentMessages: vi.fn().mockReturnValue([]),
      trimMessages: vi.fn(),
      getDossiersByGroup: vi.fn().mockReturnValue([]),
      getMemoriesByGroup: vi.fn().mockReturnValue([]),
      getActivePersonaForGroup: vi.fn().mockReturnValue(null),
      groupSettings: { getToolNotifications: vi.fn().mockReturnValue(false), isEnabled: vi.fn().mockReturnValue(true), getTriggers: vi.fn().mockReturnValue(null) },
    } as any;

    mockLLM = {
      generateResponse: vi.fn().mockResolvedValue({
        content: 'Test response',
        tokensUsed: 25,
        sentViaMcp: false,
        mcpMessages: [],
      }),
    };

    mockSignal = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendTyping: vi.fn().mockResolvedValue(undefined),
      stopTyping: vi.fn().mockResolvedValue(undefined),
    } as any;

    handler = new MessageHandler(['claude:'], {
      storage: mockStorage,
      llmClient: mockLLM,
      signalClient: mockSignal,
      appConfig: makeAppConfig(),
    });
  });

  it('should store all messages in the batch', async () => {
    const messages = [
      makeMessage({ content: 'hello', timestamp: 1000 }),
      makeMessage({ content: 'claude: hey', timestamp: 2000 }),
    ];

    await handler.handleMessageBatch('g1', messages);

    // 2 user messages + 1 bot response from LLM dispatch
    expect(mockStorage.addMessage).toHaveBeenCalledTimes(3);
    expect(mockStorage.addMessage).toHaveBeenCalledWith(expect.objectContaining({ content: 'hello', timestamp: 1000 }));
    expect(mockStorage.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'claude: hey', timestamp: 2000 }),
    );
  });

  it('should not call LLM when no messages contain mentions', async () => {
    const messages = [makeMessage({ content: 'hello' }), makeMessage({ content: 'how are you' })];

    await handler.handleMessageBatch('g1', messages);

    expect(mockLLM.generateResponse).not.toHaveBeenCalled();
  });

  it('should skip messages from the bot itself', async () => {
    const messages = [
      makeMessage({ content: 'claude: hello', sender: '+1234567890' }),
      makeMessage({ content: 'claude: hey', sender: '+61400111222' }),
    ];

    await handler.handleMessageBatch('g1', messages);

    // 1 user message + 1 bot response from LLM dispatch
    expect(mockStorage.addMessage).toHaveBeenCalledTimes(2);
    expect(mockStorage.addMessage).toHaveBeenCalledWith(expect.objectContaining({ sender: '+61400111222' }));
  });

  it('should skip duplicate messages', async () => {
    const messages = [
      makeMessage({ content: 'claude: hello', sender: '+61400111222', timestamp: 1000 }),
      makeMessage({ content: 'claude: hello', sender: '+61400111222', timestamp: 1000 }),
    ];

    await handler.handleMessageBatch('g1', messages);

    // 1 user message (dedup removes second) + 1 bot response from LLM dispatch
    expect(mockStorage.addMessage).toHaveBeenCalledTimes(2);
  });

  describe('missed message batching', () => {
    it('should make only one LLM call for multiple missed mentions', async () => {
      const now = Date.now();
      const messages = [
        makeMessage({ content: 'claude: you awake?', timestamp: now - 60000 }),
        makeMessage({ content: 'claude: hello?', timestamp: now - 30000 }),
        makeMessage({ content: 'claude: anyone there?', timestamp: now - 10000 }),
      ];

      await handler.handleMessageBatch('g1', messages);

      expect(mockLLM.generateResponse).toHaveBeenCalledTimes(1);
    });

    it('should use the latest missed mention as the primary query', async () => {
      const now = Date.now();
      const messages = [
        makeMessage({ content: 'claude: first question', timestamp: now - 60000 }),
        makeMessage({ content: 'claude: second question', timestamp: now - 10000 }),
      ];

      await handler.handleMessageBatch('g1', messages);

      const callArgs = (mockLLM.generateResponse as ReturnType<typeof vi.fn>).mock.calls[0];
      const llmMessages = callArgs[0];
      const lastUserMsg = llmMessages[llmMessages.length - 1];
      expect(lastUserMsg.content).toContain('second question');
    });

    it('should include "you were offline" framing for multiple missed mentions', async () => {
      const now = Date.now();
      const messages = [
        makeMessage({ content: 'claude: question one', sender: '+61400111222', timestamp: now - 120000 }),
        makeMessage({ content: 'claude: question two', sender: '+61400333444', timestamp: now - 60000 }),
      ];

      await handler.handleMessageBatch('g1', messages);

      const callArgs = (mockLLM.generateResponse as ReturnType<typeof vi.fn>).mock.calls[0];
      const llmMessages = callArgs[0];
      const lastUserMsg = llmMessages[llmMessages.length - 1];
      expect(lastUserMsg.content).toContain('You were offline and missed the following messages:');
      expect(lastUserMsg.content).toContain('+61400111222');
      expect(lastUserMsg.content).toContain('+61400333444');
      expect(lastUserMsg.content).toContain('question one');
      expect(lastUserMsg.content).toContain('Respond to all of these in a single message');
    });

    it('should NOT include offline framing for a single missed mention', async () => {
      const now = Date.now();
      const messages = [makeMessage({ content: 'claude: hello', timestamp: now - 60000 })];

      await handler.handleMessageBatch('g1', messages);

      const callArgs = (mockLLM.generateResponse as ReturnType<typeof vi.fn>).mock.calls[0];
      const llmMessages = callArgs[0];
      const lastUserMsg = llmMessages[llmMessages.length - 1];
      expect(lastUserMsg.content).not.toContain('You were offline');
      expect(lastUserMsg.content).toContain('hello');
    });
  });

  describe('real-time mention handling', () => {
    it('should process each real-time mention individually', async () => {
      const now = Date.now();
      const messages = [
        makeMessage({ content: 'claude: hi', sender: '+61400111222', timestamp: now }),
        makeMessage({ content: 'claude: hey', sender: '+61400333444', timestamp: now + 100 }),
      ];

      await handler.handleMessageBatch('g1', messages);

      expect(mockLLM.generateResponse).toHaveBeenCalledTimes(2);
    });

    it('should NOT include offline framing for real-time mentions', async () => {
      const now = Date.now();
      const messages = [makeMessage({ content: 'claude: hello', timestamp: now })];

      await handler.handleMessageBatch('g1', messages);

      const callArgs = (mockLLM.generateResponse as ReturnType<typeof vi.fn>).mock.calls[0];
      const llmMessages = callArgs[0];
      const lastUserMsg = llmMessages[llmMessages.length - 1];
      expect(lastUserMsg.content).not.toContain('You were offline');
    });
  });

  describe('mixed missed and real-time mentions', () => {
    it('should batch missed mentions and process real-time ones individually', async () => {
      const now = Date.now();
      const messages = [
        makeMessage({ content: 'claude: old question 1', timestamp: now - 60000 }),
        makeMessage({ content: 'claude: old question 2', timestamp: now - 30000 }),
        makeMessage({ content: 'claude: new question', timestamp: now }),
      ];

      await handler.handleMessageBatch('g1', messages);

      // 1 batched call for the 2 missed + 1 individual call for the real-time
      expect(mockLLM.generateResponse).toHaveBeenCalledTimes(2);
    });
  });

  describe('handleMessage backward compatibility', () => {
    it('should still work as before for single messages', async () => {
      await handler.handleMessage('g1', '+61400111222', 'claude: hello', Date.now());

      expect(mockLLM.generateResponse).toHaveBeenCalledTimes(1);
      expect(mockStorage.addMessage).toHaveBeenCalled();
    });
  });
});
