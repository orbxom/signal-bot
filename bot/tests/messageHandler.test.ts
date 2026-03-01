import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageHandler } from '../src/messageHandler';
import type { Message } from '../src/types';
import type { Storage } from '../src/storage';
import type { ClaudeCLIClient } from '../src/claudeClient';
import type { SignalClient } from '../src/signalClient';

describe('MessageHandler', () => {
  it('should detect bot mentions', () => {
    const handler = new MessageHandler(['@bot', 'bot:']);

    expect(handler.isMentioned('@bot hello')).toBe(true);
    expect(handler.isMentioned('bot: what time is it?')).toBe(true);
    expect(handler.isMentioned('hello everyone')).toBe(false);
  });

  it('should extract query from mentioned message', () => {
    const handler = new MessageHandler(['@bot', 'bot:']);

    expect(handler.extractQuery('@bot what is the weather?'))
      .toBe('what is the weather?');
    expect(handler.extractQuery('bot: tell me a joke'))
      .toBe('tell me a joke');
    expect(handler.extractQuery('hey @bot how are you'))
      .toBe('hey how are you');
  });

  it('should build conversation context from history', () => {
    const handler = new MessageHandler(['@bot']);

    const messages: Message[] = [
      { id: 1, groupId: 'g1', sender: 'Alice', content: 'Hello', timestamp: 1000, isBot: false },
      { id: 2, groupId: 'g1', sender: 'bot', content: 'Hi Alice!', timestamp: 2000, isBot: true },
      { id: 3, groupId: 'g1', sender: 'Bob', content: 'How are you?', timestamp: 3000, isBot: false }
    ];

    const chatMessages = handler.buildContext(messages, 'What time is it?');

    expect(chatMessages[0].role).toBe('system');
    expect(chatMessages[1].role).toBe('user');
    expect(chatMessages[1].content).toContain('Alice: Hello');
    expect(chatMessages[2].role).toBe('assistant');
    expect(chatMessages[2].content).toBe('Hi Alice!');
    expect(chatMessages[3].role).toBe('user');
    expect(chatMessages[3].content).toContain('Bob: How are you?');
    expect(chatMessages[4].role).toBe('user');
    expect(chatMessages[4].content).toContain('What time is it?');
  });

  describe('Constructor', () => {
    it('should create handler with minimal configuration', () => {
      const handler = new MessageHandler(['@bot']);
      expect(handler).toBeDefined();
    });

    it('should create handler with all options', () => {
      const handler = new MessageHandler(['@bot'], {
        storage: {} as Storage,
        llmClient: {} as ClaudeCLIClient,
        signalClient: {} as SignalClient,
        contextWindowSize: 10,
        botPhoneNumber: '+1234567890',
        systemPrompt: 'Custom prompt',
      });
      expect(handler).toBeDefined();
    });

    it('should use default context window size of 20', () => {
      const handler = new MessageHandler(['@bot']);
      expect(handler).toBeDefined();
    });

    it('should accept custom context window size', () => {
      const handler = new MessageHandler(['@bot'], { contextWindowSize: 50 });
      expect(handler).toBeDefined();
    });
  });

  describe('isMentioned', () => {
    it('should detect case-insensitive mentions', () => {
      const handler = new MessageHandler(['@bot']);

      expect(handler.isMentioned('@BOT hello')).toBe(true);
      expect(handler.isMentioned('@Bot hello')).toBe(true);
      expect(handler.isMentioned('@bot hello')).toBe(true);
    });

    it('should detect multiple trigger patterns', () => {
      const handler = new MessageHandler(['@bot', 'bot:', 'hey bot']);

      expect(handler.isMentioned('@bot hello')).toBe(true);
      expect(handler.isMentioned('bot: what time?')).toBe(true);
      expect(handler.isMentioned('hey bot how are you?')).toBe(true);
    });

    it('should handle empty content', () => {
      const handler = new MessageHandler(['@bot']);
      expect(handler.isMentioned('')).toBe(false);
    });

    it('should handle special characters in content', () => {
      const handler = new MessageHandler(['@bot']);
      expect(handler.isMentioned('@bot! What\'s up?')).toBe(true);
      // Mentions must be at the start of the message
      expect(handler.isMentioned('Hey @bot, help me.')).toBe(false);
    });
  });

  describe('extractQuery', () => {
    it('should handle multiple mentions in the same message', () => {
      const handler = new MessageHandler(['@bot']);
      expect(handler.extractQuery('@bot @bot hello')).toBe('hello');
    });

    it('should handle empty string after extraction', () => {
      const handler = new MessageHandler(['@bot']);
      expect(handler.extractQuery('@bot')).toBe('');
    });

    it('should preserve punctuation and special characters', () => {
      const handler = new MessageHandler(['@bot']);
      expect(handler.extractQuery('@bot what\'s the weather?')).toBe('what\'s the weather?');
    });

    it('should normalize whitespace', () => {
      const handler = new MessageHandler(['@bot']);
      expect(handler.extractQuery('@bot    hello    world')).toBe('hello world');
    });

    it('should remove all trigger patterns', () => {
      const handler = new MessageHandler(['@bot', 'bot:']);
      expect(handler.extractQuery('@bot bot: hello')).toBe('hello');
    });

    it('should handle triggers with regex metacharacters safely', () => {
      const handler = new MessageHandler(['$bot', 'bot+', '[bot]']);

      expect(handler.extractQuery('$bot hello')).toBe('hello');
      expect(handler.extractQuery('bot+ what is up')).toBe('what is up');
      expect(handler.extractQuery('[bot] help me')).toBe('help me');
    });
  });

  describe('buildContext', () => {
    it('should handle empty message history', () => {
      const handler = new MessageHandler(['@bot']);
      const chatMessages = handler.buildContext([], 'Hello');

      expect(chatMessages).toHaveLength(2);
      expect(chatMessages[0].role).toBe('system');
      expect(chatMessages[1].role).toBe('user');
      expect(chatMessages[1].content).toBe('Hello');
    });

    it('should preserve message order', () => {
      const handler = new MessageHandler(['@bot']);
      const messages: Message[] = [
        { id: 1, groupId: 'g1', sender: 'Alice', content: 'First', timestamp: 1000, isBot: false },
        { id: 2, groupId: 'g1', sender: 'Bob', content: 'Second', timestamp: 2000, isBot: false },
        { id: 3, groupId: 'g1', sender: 'Charlie', content: 'Third', timestamp: 3000, isBot: false }
      ];

      const chatMessages = handler.buildContext(messages, 'Query');

      expect(chatMessages[1].content).toContain('First');
      expect(chatMessages[2].content).toContain('Second');
      expect(chatMessages[3].content).toContain('Third');
    });

    it('should correctly format bot vs user messages', () => {
      const handler = new MessageHandler(['@bot']);
      const messages: Message[] = [
        { id: 1, groupId: 'g1', sender: 'Alice', content: 'Hello', timestamp: 1000, isBot: false },
        { id: 2, groupId: 'g1', sender: 'bot', content: 'Hi!', timestamp: 2000, isBot: true }
      ];

      const chatMessages = handler.buildContext(messages, 'How are you?');

      expect(chatMessages[1].role).toBe('user');
      expect(chatMessages[1].content).toBe('Alice: Hello');
      expect(chatMessages[2].role).toBe('assistant');
      expect(chatMessages[2].content).toBe('Hi!');
    });

    it('should always include system prompt first', () => {
      const handler = new MessageHandler(['@bot'], { systemPrompt: 'You are a helpful assistant.' });
      const messages: Message[] = [
        { id: 1, groupId: 'g1', sender: 'Alice', content: 'Hello', timestamp: 1000, isBot: false }
      ];

      const chatMessages = handler.buildContext(messages, 'Query');

      expect(chatMessages[0].role).toBe('system');
      expect(chatMessages[0].content).toBe('You are a helpful assistant.');
    });

    it('should use custom system prompt', () => {
      const handler = new MessageHandler(['@bot'], { systemPrompt: 'You are a pirate.' });
      const chatMessages = handler.buildContext([], 'Query');

      expect(chatMessages[0].content).toBe('You are a pirate.');
    });

    it('should always append current query last', () => {
      const handler = new MessageHandler(['@bot']);
      const messages: Message[] = [
        { id: 1, groupId: 'g1', sender: 'Alice', content: 'Hello', timestamp: 1000, isBot: false }
      ];

      const chatMessages = handler.buildContext(messages, 'What is 2+2?');
      const lastMessage = chatMessages[chatMessages.length - 1];

      expect(lastMessage.role).toBe('user');
      expect(lastMessage.content).toBe('What is 2+2?');
    });
  });

  describe('handleMessage', () => {
    let mockStorage: Storage;
    let mockLLM: ClaudeCLIClient;
    let mockSignal: SignalClient;

    beforeEach(() => {
      vi.clearAllMocks();

      mockStorage = {
        addMessage: vi.fn(),
        getRecentMessages: vi.fn().mockReturnValue([]),
        trimMessages: vi.fn()
      } as any;

      mockLLM = {
        generateResponse: vi.fn().mockResolvedValue({
          content: 'Test response',
          tokensUsed: 25
        })
      } as any;

      mockSignal = {
        sendMessage: vi.fn().mockResolvedValue(undefined)
      } as any;
    });

    it('should throw error when handler not fully initialized', async () => {
      const handler = new MessageHandler(['@bot']);

      await expect(
        handler.handleMessage('g1', 'Alice', '@bot hello', 1000)
      ).rejects.toThrow('Handler not fully initialized');
    });

    it('should skip messages from the bot itself', async () => {
      const handler = new MessageHandler(['@bot'], {
        storage: mockStorage,
        llmClient: mockLLM,
        signalClient: mockSignal,
        botPhoneNumber: '+1234567890',
      });

      await handler.handleMessage('g1', '+1234567890', '@bot hello', 1000);

      expect(mockStorage.addMessage).not.toHaveBeenCalled();
      expect(mockLLM.generateResponse).not.toHaveBeenCalled();
      expect(mockSignal.sendMessage).not.toHaveBeenCalled();
    });

    it('should process messages from other senders normally', async () => {
      const handler = new MessageHandler(['@bot'], {
        storage: mockStorage,
        llmClient: mockLLM,
        signalClient: mockSignal,
        botPhoneNumber: '+1234567890',
      });

      await handler.handleMessage('g1', '+9876543210', '@bot hello', 1000);

      expect(mockLLM.generateResponse).toHaveBeenCalled();
    });

    it('should store incoming message', async () => {
      const handler = new MessageHandler(['@bot'], {
        storage: mockStorage,
        llmClient: mockLLM,
        signalClient: mockSignal,
      });

      await handler.handleMessage('g1', 'Alice', 'Just saying hello', 1000);

      expect(mockStorage.addMessage).toHaveBeenCalledWith({
        groupId: 'g1',
        sender: 'Alice',
        content: 'Just saying hello',
        timestamp: 1000,
        isBot: false
      });
    });

    it('should not respond when not mentioned', async () => {
      const handler = new MessageHandler(['@bot'], {
        storage: mockStorage,
        llmClient: mockLLM,
        signalClient: mockSignal,
      });

      await handler.handleMessage('g1', 'Alice', 'Just saying hello', 1000);

      expect(mockLLM.generateResponse).not.toHaveBeenCalled();
      expect(mockSignal.sendMessage).not.toHaveBeenCalled();
    });

    it('should respond when mentioned', async () => {
      const handler = new MessageHandler(['@bot'], {
        storage: mockStorage,
        llmClient: mockLLM,
        signalClient: mockSignal,
      });

      await handler.handleMessage('g1', 'Alice', '@bot hello', 1000);

      expect(mockLLM.generateResponse).toHaveBeenCalled();
      expect(mockSignal.sendMessage).toHaveBeenCalledWith('g1', 'Test response');
    });

    it('should extract query and build context correctly', async () => {
      const mockHistory: Message[] = [
        { id: 1, groupId: 'g1', sender: 'Alice', content: 'Previous message', timestamp: 500, isBot: false }
      ];
      mockStorage.getRecentMessages = vi.fn().mockReturnValue(mockHistory);

      const handler = new MessageHandler(['@bot'], {
        storage: mockStorage,
        llmClient: mockLLM,
        signalClient: mockSignal,
      });

      await handler.handleMessage('g1', 'Bob', '@bot what is 2+2?', 1000);

      expect(mockLLM.generateResponse).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ role: 'system' }),
          expect.objectContaining({ role: 'user', content: 'Alice: Previous message' }),
          expect.objectContaining({ role: 'user', content: 'what is 2+2?' })
        ])
      );
    });

    it('should store bot response after sending', async () => {
      const handler = new MessageHandler(['@bot'], {
        storage: mockStorage,
        llmClient: mockLLM,
        signalClient: mockSignal,
      });
      vi.spyOn(Date, 'now').mockReturnValue(2000);

      await handler.handleMessage('g1', 'Alice', '@bot hello', 1000);

      expect(mockStorage.addMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          groupId: 'g1',
          content: 'Test response',
          timestamp: 2000,
          isBot: true
        })
      );
    });

    it('should trim messages after responding', async () => {
      const handler = new MessageHandler(['@bot'], {
        storage: mockStorage,
        llmClient: mockLLM,
        signalClient: mockSignal,
        contextWindowSize: 20,
      });

      await handler.handleMessage('g1', 'Alice', '@bot hello', 1000);

      expect(mockStorage.trimMessages).toHaveBeenCalledWith('g1', 20);
    });

    it('should handle LLM errors gracefully', async () => {
      mockLLM.generateResponse = vi.fn().mockRejectedValue(new Error('LLM API error'));
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const handler = new MessageHandler(['@bot'], {
        storage: mockStorage,
        llmClient: mockLLM,
        signalClient: mockSignal,
      });

      await handler.handleMessage('g1', 'Alice', '@bot hello', 1000);

      expect(consoleErrorSpy).toHaveBeenCalled();
      expect(mockSignal.sendMessage).toHaveBeenCalledWith(
        'g1',
        'Sorry, I encountered an error processing your request.'
      );

      consoleErrorSpy.mockRestore();
    });

    it('should handle Signal client errors gracefully', async () => {
      mockSignal.sendMessage = vi.fn().mockRejectedValue(new Error('Signal API error'));
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const handler = new MessageHandler(['@bot'], {
        storage: mockStorage,
        llmClient: mockLLM,
        signalClient: mockSignal,
      });

      await handler.handleMessage('g1', 'Alice', '@bot hello', 1000);

      expect(consoleErrorSpy).toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
    });

    it('should use correct context window size', async () => {
      const handler = new MessageHandler(['@bot'], {
        storage: mockStorage,
        llmClient: mockLLM,
        signalClient: mockSignal,
        contextWindowSize: 10,
      });

      await handler.handleMessage('g1', 'Alice', '@bot hello', 1000);

      expect(mockStorage.getRecentMessages).toHaveBeenCalledWith('g1', 9);
      expect(mockStorage.trimMessages).toHaveBeenCalledWith('g1', 10);
    });

    it('should log response with token usage', async () => {
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const handler = new MessageHandler(['@bot'], {
        storage: mockStorage,
        llmClient: mockLLM,
        signalClient: mockSignal,
      });

      await handler.handleMessage('g1', 'Alice', '@bot hello', 1000);

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('[g1]')
      );
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('Alice')
      );
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('25 tokens')
      );

      consoleLogSpy.mockRestore();
    });

    it('should ignore duplicate messages with same groupId/sender/timestamp', async () => {
      const handler = new MessageHandler(['@bot'], {
        storage: mockStorage,
        llmClient: mockLLM,
        signalClient: mockSignal,
      });

      await handler.handleMessage('g1', 'Alice', '@bot hello', 1000);
      await handler.handleMessage('g1', 'Alice', '@bot hello', 1000);

      // LLM should only be called once
      expect(mockLLM.generateResponse).toHaveBeenCalledTimes(1);
    });

    it('should process different messages normally', async () => {
      const handler = new MessageHandler(['@bot'], {
        storage: mockStorage,
        llmClient: mockLLM,
        signalClient: mockSignal,
      });

      await handler.handleMessage('g1', 'Alice', '@bot hello', 1000);
      await handler.handleMessage('g1', 'Alice', '@bot hello', 2000);

      expect(mockLLM.generateResponse).toHaveBeenCalledTimes(2);
    });
  });
});
