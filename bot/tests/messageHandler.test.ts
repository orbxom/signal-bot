import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeCLIClient } from '../src/claudeClient';
import { ACK_MESSAGES, MessageHandler } from '../src/messageHandler';
import type { SignalClient } from '../src/signalClient';
import type { Storage } from '../src/storage';
import type { Message } from '../src/types';

describe('MessageHandler', () => {
  describe('ACK_MESSAGES', () => {
    it('should contain exactly 10 messages', () => {
      expect(ACK_MESSAGES).toHaveLength(10);
    });

    it('should contain only non-empty strings', () => {
      for (const msg of ACK_MESSAGES) {
        expect(typeof msg).toBe('string');
        expect(msg.length).toBeGreaterThan(0);
      }
    });
  });

  it('should detect bot mentions', () => {
    const handler = new MessageHandler(['@bot', 'bot:']);

    expect(handler.isMentioned('@bot hello')).toBe(true);
    expect(handler.isMentioned('bot: what time is it?')).toBe(true);
    expect(handler.isMentioned('hello everyone')).toBe(false);
  });

  it('should extract query from mentioned message', () => {
    const handler = new MessageHandler(['@bot', 'bot:']);

    expect(handler.extractQuery('@bot what is the weather?')).toBe('what is the weather?');
    expect(handler.extractQuery('bot: tell me a joke')).toBe('tell me a joke');
    expect(handler.extractQuery('hey @bot how are you')).toBe('hey how are you');
  });

  it('should build conversation context from history', () => {
    const handler = new MessageHandler(['@bot']);

    const messages: Message[] = [
      { id: 1, groupId: 'g1', sender: 'Alice', content: 'Hello', timestamp: 1000, isBot: false },
      { id: 2, groupId: 'g1', sender: 'bot', content: 'Hi Alice!', timestamp: 2000, isBot: true },
      { id: 3, groupId: 'g1', sender: 'Bob', content: 'How are you?', timestamp: 3000, isBot: false },
    ];

    const chatMessages = handler.buildContext(messages, 'What time is it?');

    expect(chatMessages[0].role).toBe('system');
    expect(chatMessages[1].role).toBe('user');
    expect(chatMessages[1].content).toBe('[1970-01-01 10:00] Alice: Hello');
    expect(chatMessages[2].role).toBe('assistant');
    expect(chatMessages[2].content).toBe('[1970-01-01 10:00] Hi Alice!');
    expect(chatMessages[3].role).toBe('user');
    expect(chatMessages[3].content).toBe('[1970-01-01 10:00] Bob: How are you?');
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

    it('should use default context window size of 200', () => {
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
      expect(handler.isMentioned("@bot! What's up?")).toBe(true);
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
      expect(handler.extractQuery("@bot what's the weather?")).toBe("what's the weather?");
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
        { id: 3, groupId: 'g1', sender: 'Charlie', content: 'Third', timestamp: 3000, isBot: false },
      ];

      const chatMessages = handler.buildContext(messages, 'Query');

      expect(chatMessages[1].content).toBe('[1970-01-01 10:00] Alice: First');
      expect(chatMessages[2].content).toBe('[1970-01-01 10:00] Bob: Second');
      expect(chatMessages[3].content).toBe('[1970-01-01 10:00] Charlie: Third');
    });

    it('should correctly format bot vs user messages', () => {
      const handler = new MessageHandler(['@bot']);
      const messages: Message[] = [
        { id: 1, groupId: 'g1', sender: 'Alice', content: 'Hello', timestamp: 1000, isBot: false },
        { id: 2, groupId: 'g1', sender: 'bot', content: 'Hi!', timestamp: 2000, isBot: true },
      ];

      const chatMessages = handler.buildContext(messages, 'How are you?');

      expect(chatMessages[1].role).toBe('user');
      expect(chatMessages[1].content).toBe('[1970-01-01 10:00] Alice: Hello');
      expect(chatMessages[2].role).toBe('assistant');
      expect(chatMessages[2].content).toBe('[1970-01-01 10:00] Hi!');
    });

    it('should always include system prompt first', () => {
      const handler = new MessageHandler(['@bot'], { systemPrompt: 'You are a helpful assistant.' });
      const messages: Message[] = [
        { id: 1, groupId: 'g1', sender: 'Alice', content: 'Hello', timestamp: 1000, isBot: false },
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
        { id: 1, groupId: 'g1', sender: 'Alice', content: 'Hello', timestamp: 1000, isBot: false },
      ];

      const chatMessages = handler.buildContext(messages, 'What is 2+2?');
      const lastMessage = chatMessages[chatMessages.length - 1];

      expect(lastMessage.role).toBe('user');
      expect(lastMessage.content).toBe('What is 2+2?');
    });

    it('should include dossier context in system prompt when provided', () => {
      const handler = new MessageHandler(['@bot'], { systemPrompt: 'You are a helpful bot.' });
      const dossierContext = '## People in this group\n- Alice (+61400000001)\n  Loves cats';

      const chatMessages = handler.buildContext([], 'Hello', 'g1', '+61400000001', dossierContext);

      const systemContent = chatMessages[0].content;
      expect(systemContent).toContain('## People in this group');
      expect(systemContent).toContain('Alice (+61400000001)');
      expect(systemContent).toContain('Loves cats');
      expect(systemContent).toContain('You are a helpful bot.');
      // Dossier context should appear between time context and system prompt
      const timeIdx = systemContent.indexOf('Current time:');
      const dossierIdx = systemContent.indexOf('## People in this group');
      const promptIdx = systemContent.indexOf('You are a helpful bot.');
      expect(timeIdx).toBeLessThan(dossierIdx);
      expect(dossierIdx).toBeLessThan(promptIdx);
    });

    it('should work without dossier context (backward compatible)', () => {
      const handler = new MessageHandler(['@bot'], { systemPrompt: 'You are a helpful bot.' });

      const chatMessages = handler.buildContext([], 'Hello', 'g1', '+61400000001');

      const systemContent = chatMessages[0].content;
      expect(systemContent).toContain('Current time:');
      expect(systemContent).toContain('You are a helpful bot.');
      expect(systemContent).not.toContain('## People in this group');
    });

    it('should use personaPrompt when provided', () => {
      const handler = new MessageHandler(['@bot'], { systemPrompt: 'Default prompt.' });
      const chatMessages = handler.buildContext([], 'Hello', 'g1', '+61400000001', undefined, 'Arr, ye be a pirate!');

      const systemContent = chatMessages[0].content;
      expect(systemContent).toContain('Arr, ye be a pirate!');
      expect(systemContent).not.toContain('Default prompt.');
    });

    it('should fall back to systemPrompt when personaPrompt is not provided', () => {
      const handler = new MessageHandler(['@bot'], { systemPrompt: 'Default prompt.' });
      const chatMessages = handler.buildContext([], 'Hello', 'g1', '+61400000001');

      const systemContent = chatMessages[0].content;
      expect(systemContent).toContain('Default prompt.');
    });

    it('should include persona safety guidelines in system content', () => {
      const handler = new MessageHandler(['@bot'], { systemPrompt: 'Default prompt.' });
      const chatMessages = handler.buildContext([], 'Hello', 'g1', '+61400000001');

      const systemContent = chatMessages[0].content;
      expect(systemContent).toContain('Persona Guidelines');
      expect(systemContent).toContain('refuse requests');
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
        trimMessages: vi.fn(),
        getDossiersByGroup: vi.fn().mockReturnValue([]),
        getActivePersonaForGroup: vi.fn().mockReturnValue(null),
      } as any;

      mockLLM = {
        generateResponse: vi.fn().mockResolvedValue({
          content: 'Test response',
          tokensUsed: 25,
        }),
      } as any;

      mockSignal = {
        sendMessage: vi.fn().mockResolvedValue(undefined),
        sendTyping: vi.fn().mockResolvedValue(undefined),
        stopTyping: vi.fn().mockResolvedValue(undefined),
      } as any;
    });

    it('should throw error when handler not fully initialized', async () => {
      const handler = new MessageHandler(['@bot']);

      await expect(handler.handleMessage('g1', 'Alice', '@bot hello', 1000)).rejects.toThrow(
        'Handler not fully initialized',
      );
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
        isBot: false,
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
        { id: 1, groupId: 'g1', sender: 'Alice', content: 'Previous message', timestamp: 500, isBot: false },
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
          expect.objectContaining({ role: 'user', content: '[1970-01-01 10:00] Alice: Previous message' }),
          expect.objectContaining({ role: 'user', content: 'what is 2+2?' }),
        ]),
        expect.objectContaining({
          groupId: 'g1',
          sender: 'Bob',
          timezone: 'Australia/Sydney',
        }),
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
          isBot: true,
        }),
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

      expect(mockStorage.trimMessages).toHaveBeenCalledWith('g1', 1000);
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
        'Sorry, I encountered an error processing your request.',
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

      expect(mockStorage.getRecentMessages).toHaveBeenCalledWith('g1', 10);
      expect(mockStorage.trimMessages).toHaveBeenCalledWith('g1', 1000);
    });

    it('should log response with token usage', async () => {
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const handler = new MessageHandler(['@bot'], {
        storage: mockStorage,
        llmClient: mockLLM,
        signalClient: mockSignal,
      });

      await handler.handleMessage('g1', 'Alice', '@bot hello', 1000);

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('[g1]'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Alice'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('25 tokens'));

      consoleLogSpy.mockRestore();
    });

    it('should load dossiers and include them in LLM context', async () => {
      mockStorage.getDossiersByGroup = vi.fn().mockReturnValue([
        {
          id: 1,
          groupId: 'g1',
          personId: '+61400000001',
          displayName: 'Alice',
          notes: 'Loves cats',
          createdAt: 1000,
          updatedAt: 2000,
        },
        {
          id: 2,
          groupId: 'g1',
          personId: '+61400000002',
          displayName: 'Bob',
          notes: 'Enjoys hiking',
          createdAt: 1000,
          updatedAt: 2000,
        },
      ]);

      const handler = new MessageHandler(['@bot'], {
        storage: mockStorage,
        llmClient: mockLLM,
        signalClient: mockSignal,
      });

      await handler.handleMessage('g1', 'Alice', '@bot hello', 1000);

      expect(mockStorage.getDossiersByGroup).toHaveBeenCalledWith('g1');

      // Verify the system prompt includes dossier information
      const callArgs = (mockLLM.generateResponse as ReturnType<typeof vi.fn>).mock.calls[0];
      const messages = callArgs[0];
      const systemMsg = messages.find((m: { role: string }) => m.role === 'system');
      expect(systemMsg.content).toContain('## People in this group');
      expect(systemMsg.content).toContain('Alice (+61400000001)');
      expect(systemMsg.content).toContain('Loves cats');
      expect(systemMsg.content).toContain('Bob (+61400000002)');
      expect(systemMsg.content).toContain('Enjoys hiking');
    });

    it('should not include dossier section when no dossiers exist', async () => {
      mockStorage.getDossiersByGroup = vi.fn().mockReturnValue([]);

      const handler = new MessageHandler(['@bot'], {
        storage: mockStorage,
        llmClient: mockLLM,
        signalClient: mockSignal,
      });

      await handler.handleMessage('g1', 'Alice', '@bot hello', 1000);

      const callArgs = (mockLLM.generateResponse as ReturnType<typeof vi.fn>).mock.calls[0];
      const messages = callArgs[0];
      const systemMsg = messages.find((m: { role: string }) => m.role === 'system');
      expect(systemMsg.content).not.toContain('## People in this group');
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

    describe('acknowledgement messages', () => {
      it('should send an acknowledgement message before calling LLM', async () => {
        const handler = new MessageHandler(['@bot'], {
          storage: mockStorage,
          llmClient: mockLLM,
          signalClient: mockSignal,
        });

        await handler.handleMessage('g1', 'Alice', '@bot hello', 1000);

        // sendMessage called twice: once for ack, once for response
        expect(mockSignal.sendMessage).toHaveBeenCalledTimes(2);

        // First call is the acknowledgement (one of ACK_MESSAGES)
        const firstCallMsg = mockSignal.sendMessage.mock.calls[0][1];
        expect(ACK_MESSAGES).toContain(firstCallMsg);

        // Second call is the LLM response
        expect(mockSignal.sendMessage).toHaveBeenNthCalledWith(2, 'g1', 'Test response');
      });

      it('should not send acknowledgement when not mentioned', async () => {
        const handler = new MessageHandler(['@bot'], {
          storage: mockStorage,
          llmClient: mockLLM,
          signalClient: mockSignal,
        });

        await handler.handleMessage('g1', 'Alice', 'Just saying hello', 1000);

        expect(mockSignal.sendMessage).not.toHaveBeenCalled();
      });

      it('should still call LLM and send response when acknowledgement fails', async () => {
        mockSignal.sendMessage = vi
          .fn()
          .mockRejectedValueOnce(new Error('Ack failed'))
          .mockResolvedValueOnce(undefined);
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const handler = new MessageHandler(['@bot'], {
          storage: mockStorage,
          llmClient: mockLLM,
          signalClient: mockSignal,
        });

        await handler.handleMessage('g1', 'Alice', '@bot hello', 1000);

        expect(mockLLM.generateResponse).toHaveBeenCalled();
        expect(mockSignal.sendMessage).toHaveBeenCalledTimes(2);
        expect(mockSignal.sendMessage).toHaveBeenNthCalledWith(2, 'g1', 'Test response');

        consoleErrorSpy.mockRestore();
      });

      it('should pick acknowledgement message based on Math.random', async () => {
        vi.spyOn(Math, 'random').mockReturnValue(0);

        const handler = new MessageHandler(['@bot'], {
          storage: mockStorage,
          llmClient: mockLLM,
          signalClient: mockSignal,
        });

        await handler.handleMessage('g1', 'Alice', '@bot hello', 1000);

        expect(mockSignal.sendMessage).toHaveBeenNthCalledWith(1, 'g1', ACK_MESSAGES[0]);

        vi.restoreAllMocks();
      });

      it('should pick last acknowledgement message when Math.random returns 0.99', async () => {
        vi.spyOn(Math, 'random').mockReturnValue(0.99);

        const handler = new MessageHandler(['@bot'], {
          storage: mockStorage,
          llmClient: mockLLM,
          signalClient: mockSignal,
        });

        await handler.handleMessage('g1', 'Alice', '@bot hello', 2000);

        expect(mockSignal.sendMessage).toHaveBeenNthCalledWith(1, 'g1', ACK_MESSAGES[9]);

        vi.restoreAllMocks();
      });
    });

    it('should call signal client methods in correct order: ack, sendTyping, response, stopTyping', async () => {
      const callOrder: string[] = [];

      mockSignal.sendMessage = vi.fn().mockImplementation(async (_groupId: string, _msg: string) => {
        callOrder.push(`sendMessage:${_msg}`);
      });
      mockSignal.sendTyping = vi.fn().mockImplementation(async () => {
        callOrder.push('sendTyping');
      });
      mockSignal.stopTyping = vi.fn().mockImplementation(async () => {
        callOrder.push('stopTyping');
      });

      vi.spyOn(Math, 'random').mockReturnValue(0);

      const handler = new MessageHandler(['@bot'], {
        storage: mockStorage,
        llmClient: mockLLM,
        signalClient: mockSignal,
      });

      await handler.handleMessage('g1', 'Alice', '@bot hello', 1000);

      // Filter out any interval-based sendTyping calls to test core ordering
      const coreOrder = callOrder.filter(
        (entry, i) => !(entry === 'sendTyping' && i > callOrder.indexOf('sendTyping')),
      );
      expect(coreOrder).toEqual([
        `sendMessage:${ACK_MESSAGES[0]}`,
        'sendTyping',
        'sendMessage:Test response',
        'stopTyping',
      ]);

      vi.restoreAllMocks();
    });

    describe('voice attachment handling', () => {
      it('should include voice attachment info in query when present', async () => {
        const handler = new MessageHandler(['@bot'], {
          storage: mockStorage,
          llmClient: mockLLM,
          signalClient: mockSignal,
        });

        await handler.handleMessage('g1', 'Alice', '@bot', 1000, [
          { id: 'voice-abc', contentType: 'audio/aac', size: 5000, filename: null },
        ]);

        const callArgs = (mockLLM.generateResponse as ReturnType<typeof vi.fn>).mock.calls[0];
        const messages = callArgs[0];
        const lastUserMsg = messages[messages.length - 1];
        expect(lastUserMsg.content).toContain('[Voice message attached:');
        expect(lastUserMsg.content).toContain('voice-abc');
      });

      it('should treat voice-only message with trigger as mentioned', async () => {
        const handler = new MessageHandler(['@bot'], {
          storage: mockStorage,
          llmClient: mockLLM,
          signalClient: mockSignal,
        });

        await handler.handleMessage('g1', 'Alice', '@bot', 1000, [
          { id: 'voice-xyz', contentType: 'audio/aac', size: 3000, filename: null },
        ]);

        expect(mockLLM.generateResponse).toHaveBeenCalled();
      });

      it('should ignore non-audio attachments', async () => {
        const handler = new MessageHandler(['@bot'], {
          storage: mockStorage,
          llmClient: mockLLM,
          signalClient: mockSignal,
        });

        await handler.handleMessage('g1', 'Alice', '@bot check this image', 1000, [
          { id: 'image-abc', contentType: 'image/jpeg', size: 50000, filename: 'photo.jpg' },
        ]);

        const callArgs = (mockLLM.generateResponse as ReturnType<typeof vi.fn>).mock.calls[0];
        const messages = callArgs[0];
        const lastUserMsg = messages[messages.length - 1];
        expect(lastUserMsg.content).not.toContain('[Voice message attached:');
      });
    });

    describe('voice attachments from history', () => {
      it('should include voice attachment paths from history messages in context', async () => {
        const mockHistory: Message[] = [
          {
            id: 1,
            groupId: 'g1',
            sender: 'Alice',
            content: '',
            timestamp: 500,
            isBot: false,
            attachments: [{ id: 'voice-abc', contentType: 'audio/aac', size: 5000, filename: null }],
          },
        ];
        mockStorage.getRecentMessages = vi.fn().mockReturnValue(mockHistory);

        const handler = new MessageHandler(['@bot'], {
          storage: mockStorage,
          llmClient: mockLLM,
          signalClient: mockSignal,
          attachmentsDir: '/data/attachments',
        });

        await handler.handleMessage('g1', 'Bob', '@bot transcribe that', 1000);

        const callArgs = (mockLLM.generateResponse as ReturnType<typeof vi.fn>).mock.calls[0];
        const messages = callArgs[0];
        // History message should include voice attachment path
        const historyMsg = messages.find(
          (m: { role: string; content: string }) => m.role === 'user' && m.content.includes('Alice'),
        );
        expect(historyMsg.content).toContain('[Voice message attached: /data/attachments/voice-abc]');
      });

      it('should not include non-audio attachments from history in context', async () => {
        const mockHistory: Message[] = [
          {
            id: 1,
            groupId: 'g1',
            sender: 'Alice',
            content: 'check this',
            timestamp: 500,
            isBot: false,
            attachments: [{ id: 'img-123', contentType: 'image/jpeg', size: 50000, filename: 'photo.jpg' }],
          },
        ];
        mockStorage.getRecentMessages = vi.fn().mockReturnValue(mockHistory);

        const handler = new MessageHandler(['@bot'], {
          storage: mockStorage,
          llmClient: mockLLM,
          signalClient: mockSignal,
        });

        await handler.handleMessage('g1', 'Bob', '@bot what was that', 1000);

        const callArgs = (mockLLM.generateResponse as ReturnType<typeof vi.fn>).mock.calls[0];
        const messages = callArgs[0];
        const historyMsg = messages.find(
          (m: { role: string; content: string }) => m.role === 'user' && m.content.includes('Alice'),
        );
        expect(historyMsg.content).not.toContain('[Voice message attached:');
      });

      it('should store attachments when saving incoming message', async () => {
        const handler = new MessageHandler(['@bot'], {
          storage: mockStorage,
          llmClient: mockLLM,
          signalClient: mockSignal,
        });

        const attachments = [{ id: 'voice-xyz', contentType: 'audio/aac', size: 3000, filename: null }];
        await handler.handleMessage('g1', 'Alice', 'hello', 1000, attachments);

        expect(mockStorage.addMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            attachments,
          }),
        );
      });
    });

    describe('typing indicators', () => {
      it('should start typing indicator when mentioned', async () => {
        const handler = new MessageHandler(['@bot'], {
          storage: mockStorage,
          llmClient: mockLLM,
          signalClient: mockSignal,
        });

        await handler.handleMessage('g1', 'Alice', '@bot hello', 1000);

        expect(mockSignal.sendTyping).toHaveBeenCalledWith('g1');
      });

      it('should stop typing indicator after sending response', async () => {
        const handler = new MessageHandler(['@bot'], {
          storage: mockStorage,
          llmClient: mockLLM,
          signalClient: mockSignal,
        });

        await handler.handleMessage('g1', 'Alice', '@bot hello', 1000);

        expect(mockSignal.stopTyping).toHaveBeenCalledWith('g1');
      });

      it('should stop typing indicator even when LLM call fails', async () => {
        mockLLM.generateResponse = vi.fn().mockRejectedValue(new Error('LLM API error'));
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const handler = new MessageHandler(['@bot'], {
          storage: mockStorage,
          llmClient: mockLLM,
          signalClient: mockSignal,
        });

        await handler.handleMessage('g1', 'Alice', '@bot hello', 1000);

        expect(mockSignal.stopTyping).toHaveBeenCalledWith('g1');

        consoleErrorSpy.mockRestore();
      });

      it('should not start typing indicator when not mentioned', async () => {
        const handler = new MessageHandler(['@bot'], {
          storage: mockStorage,
          llmClient: mockLLM,
          signalClient: mockSignal,
        });

        await handler.handleMessage('g1', 'Alice', 'Just saying hello', 1000);

        expect(mockSignal.sendTyping).not.toHaveBeenCalled();
        expect(mockSignal.stopTyping).not.toHaveBeenCalled();
      });

      it('should still call LLM when typing indicator start fails', async () => {
        mockSignal.sendTyping = vi.fn().mockRejectedValue(new Error('Typing failed'));
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const handler = new MessageHandler(['@bot'], {
          storage: mockStorage,
          llmClient: mockLLM,
          signalClient: mockSignal,
        });

        await handler.handleMessage('g1', 'Alice', '@bot hello', 1000);

        expect(mockLLM.generateResponse).toHaveBeenCalled();
        expect(mockSignal.sendMessage).toHaveBeenCalledWith('g1', 'Test response');

        consoleErrorSpy.mockRestore();
      });

      it('should not throw when typing indicator stop fails', async () => {
        mockSignal.stopTyping = vi.fn().mockRejectedValue(new Error('Stop typing failed'));
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const handler = new MessageHandler(['@bot'], {
          storage: mockStorage,
          llmClient: mockLLM,
          signalClient: mockSignal,
        });

        await handler.handleMessage('g1', 'Alice', '@bot hello', 1000);

        expect(mockSignal.sendMessage).toHaveBeenCalledWith('g1', 'Test response');

        consoleErrorSpy.mockRestore();
      });

      it('should refresh typing indicator during long-running LLM calls', async () => {
        vi.useFakeTimers();

        // Simulate a 25-second LLM call
        mockLLM.generateResponse = vi.fn().mockImplementation(
          () =>
            new Promise(resolve => {
              setTimeout(() => resolve({ content: 'Slow response', tokensUsed: 500 }), 25_000);
            }),
        );

        const handler = new MessageHandler(['@bot'], {
          storage: mockStorage,
          llmClient: mockLLM,
          signalClient: mockSignal,
        });

        const promise = handler.handleMessage('g1', 'Alice', '@bot hello', 1000);

        // Initial sendTyping call
        await vi.advanceTimersByTimeAsync(0);
        expect(mockSignal.sendTyping).toHaveBeenCalledTimes(1);

        // After 10s, interval fires
        await vi.advanceTimersByTimeAsync(10_000);
        expect(mockSignal.sendTyping).toHaveBeenCalledTimes(2);

        // After 20s, interval fires again
        await vi.advanceTimersByTimeAsync(10_000);
        expect(mockSignal.sendTyping).toHaveBeenCalledTimes(3);

        // Let the LLM resolve at 25s
        await vi.advanceTimersByTimeAsync(5_000);
        await promise;

        // No more calls after resolution
        expect(mockSignal.stopTyping).toHaveBeenCalledWith('g1');

        vi.useRealTimers();
      });

      it('should clear typing interval even when LLM errors', async () => {
        vi.useFakeTimers();

        mockLLM.generateResponse = vi.fn().mockImplementation(
          () =>
            new Promise((_, reject) => {
              setTimeout(() => reject(new Error('LLM failed')), 15_000);
            }),
        );
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const handler = new MessageHandler(['@bot'], {
          storage: mockStorage,
          llmClient: mockLLM,
          signalClient: mockSignal,
        });

        const promise = handler.handleMessage('g1', 'Alice', '@bot hello', 1000);

        // Initial sendTyping + one interval tick at 10s
        await vi.advanceTimersByTimeAsync(10_000);
        expect(mockSignal.sendTyping).toHaveBeenCalledTimes(2);

        // Let the LLM reject at 15s
        await vi.advanceTimersByTimeAsync(5_000);
        await promise;

        // Reset the mock call count to verify no more interval calls
        mockSignal.sendTyping.mockClear();

        // Advance well past the next interval tick
        await vi.advanceTimersByTimeAsync(20_000);
        expect(mockSignal.sendTyping).not.toHaveBeenCalled();

        expect(mockSignal.stopTyping).toHaveBeenCalledWith('g1');

        consoleErrorSpy.mockRestore();
        vi.useRealTimers();
      });
    });

    describe('persona integration', () => {
      it('should use active persona description in system prompt', async () => {
        mockStorage.getActivePersonaForGroup = vi.fn().mockReturnValue({
          id: 2,
          name: 'Pirate',
          description: 'Ye be a pirate captain! Speak in pirate dialect.',
          tags: 'fun,pirate',
          isDefault: 0,
          createdAt: 1000,
          updatedAt: 1000,
        });

        const handler = new MessageHandler(['@bot'], {
          storage: mockStorage,
          llmClient: mockLLM,
          signalClient: mockSignal,
          systemPrompt: 'Default assistant prompt.',
        });

        await handler.handleMessage('g1', 'Alice', '@bot hello', 1000);

        const callArgs = (mockLLM.generateResponse as ReturnType<typeof vi.fn>).mock.calls[0];
        const messages = callArgs[0];
        const systemMsg = messages.find((m: { role: string }) => m.role === 'system');
        expect(systemMsg.content).toContain('Ye be a pirate captain!');
        expect(systemMsg.content).not.toContain('Default assistant prompt.');
      });

      it('should fall back to system prompt when no active persona', async () => {
        mockStorage.getActivePersonaForGroup = vi.fn().mockReturnValue(null);

        const handler = new MessageHandler(['@bot'], {
          storage: mockStorage,
          llmClient: mockLLM,
          signalClient: mockSignal,
          systemPrompt: 'Default assistant prompt.',
        });

        await handler.handleMessage('g1', 'Alice', '@bot hello', 1000);

        const callArgs = (mockLLM.generateResponse as ReturnType<typeof vi.fn>).mock.calls[0];
        const messages = callArgs[0];
        const systemMsg = messages.find((m: { role: string }) => m.role === 'system');
        expect(systemMsg.content).toContain('Default assistant prompt.');
      });

      it('should call getActivePersonaForGroup with correct groupId', async () => {
        const handler = new MessageHandler(['@bot'], {
          storage: mockStorage,
          llmClient: mockLLM,
          signalClient: mockSignal,
        });

        await handler.handleMessage('test-group-123', 'Alice', '@bot hello', 1000);

        expect(mockStorage.getActivePersonaForGroup).toHaveBeenCalledWith('test-group-123');
      });
    });
  });
});
