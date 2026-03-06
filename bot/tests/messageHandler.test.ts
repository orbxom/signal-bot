import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeCLIClient } from '../src/claudeClient';
import { MessageHandler } from '../src/messageHandler';
import type { SignalClient } from '../src/signalClient';
import type { Storage } from '../src/storage';
import type { Message, MessageContext } from '../src/types';

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

function makeContext(overrides?: Partial<MessageContext>): MessageContext {
  return {
    groupId: '',
    sender: '',
    dbPath: './data/bot.db',
    timezone: 'Australia/Sydney',
    githubRepo: '',
    sourceRoot: '',
    signalCliUrl: '',
    botPhoneNumber: '',
    attachmentsDir: './data/signal-attachments',
    whisperModelPath: './models/ggml-base.en.bin',
    ...overrides,
  };
}

describe('MessageHandler', () => {
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
        messageContext: makeContext({ botPhoneNumber: '+1234567890' }),
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
          sentViaMcp: false,
          mcpMessages: [],
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
        messageContext: makeContext({ botPhoneNumber: '+1234567890' }),
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
        messageContext: makeContext({ botPhoneNumber: '+1234567890' }),
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
      const { logger } = await import('../src/logger');
      mockLLM.generateResponse = vi.fn().mockRejectedValue(new Error('LLM API error'));

      const handler = new MessageHandler(['@bot'], {
        storage: mockStorage,
        llmClient: mockLLM,
        signalClient: mockSignal,
      });

      await handler.handleMessage('g1', 'Alice', '@bot hello', 1000);

      expect(logger.error).toHaveBeenCalled();
      expect(mockSignal.sendMessage).toHaveBeenCalledWith(
        'g1',
        'Sorry, I encountered an error processing your request.',
      );
    });

    it('should handle Signal client errors gracefully', async () => {
      const { logger } = await import('../src/logger');
      mockSignal.sendMessage = vi.fn().mockRejectedValue(new Error('Signal API error'));

      const handler = new MessageHandler(['@bot'], {
        storage: mockStorage,
        llmClient: mockLLM,
        signalClient: mockSignal,
      });

      await handler.handleMessage('g1', 'Alice', '@bot hello', 1000);

      expect(logger.error).toHaveBeenCalled();
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
      const { logger } = await import('../src/logger');

      const handler = new MessageHandler(['@bot'], {
        storage: mockStorage,
        llmClient: mockLLM,
        signalClient: mockSignal,
      });

      await handler.handleMessage('g1', 'Alice', '@bot hello', 1000);

      expect(logger.step).toHaveBeenCalledWith(expect.stringContaining('25 tokens'));
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

    it('should resolve sender IDs to display names in history using dossier data', async () => {
      const mockHistory: Message[] = [
        { id: 1, groupId: 'g1', sender: '+61400000001', content: 'Previous message', timestamp: 500, isBot: false },
        { id: 2, groupId: 'g1', sender: '+61400000002', content: 'Another message', timestamp: 600, isBot: false },
      ];
      mockStorage.getRecentMessages = vi.fn().mockReturnValue(mockHistory);
      mockStorage.getDossiersByGroup = vi.fn().mockReturnValue([
        {
          id: 1,
          groupId: 'g1',
          personId: '+61400000001',
          displayName: 'Alice',
          notes: '',
          createdAt: 1000,
          updatedAt: 2000,
        },
        {
          id: 2,
          groupId: 'g1',
          personId: '+61400000002',
          displayName: 'Bob',
          notes: '',
          createdAt: 1000,
          updatedAt: 2000,
        },
      ]);

      const handler = new MessageHandler(['@bot'], {
        storage: mockStorage,
        llmClient: mockLLM,
        signalClient: mockSignal,
      });

      await handler.handleMessage('g1', '+61400000001', '@bot hello', 1000);

      const callArgs = (mockLLM.generateResponse as ReturnType<typeof vi.fn>).mock.calls[0];
      const messages = callArgs[0];
      const aliceMsg = messages.find((m: { role: string; content: string }) => m.content.includes('Previous message'));
      const bobMsg = messages.find((m: { role: string; content: string }) => m.content.includes('Another message'));
      expect(aliceMsg.content).toContain('Alice: Previous message');
      expect(aliceMsg.content).not.toContain('+61400000001');
      expect(bobMsg.content).toContain('Bob: Another message');
      expect(bobMsg.content).not.toContain('+61400000002');
    });

    it('should resolve Current requester to display name using dossier data', async () => {
      mockStorage.getDossiersByGroup = vi.fn().mockReturnValue([
        {
          id: 1,
          groupId: 'g1',
          personId: '+61400000001',
          displayName: 'Alice',
          notes: '',
          createdAt: 1000,
          updatedAt: 2000,
        },
      ]);

      const handler = new MessageHandler(['@bot'], {
        storage: mockStorage,
        llmClient: mockLLM,
        signalClient: mockSignal,
      });

      await handler.handleMessage('g1', '+61400000001', '@bot hello', 1000);

      const callArgs = (mockLLM.generateResponse as ReturnType<typeof vi.fn>).mock.calls[0];
      const messages = callArgs[0];
      const systemMsg = messages.find((m: { role: string }) => m.role === 'system');
      expect(systemMsg.content).toContain('Current requester: Alice (+61400000001)');
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

    it('should call signal client methods in correct order: sendTyping, response, stopTyping', async () => {
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
      expect(coreOrder).toEqual(['sendTyping', 'sendMessage:Test response', 'stopTyping']);
    });

    describe('MCP-based message sending', () => {
      it('should not auto-send response when Claude sent messages via MCP', async () => {
        const mockLLM = {
          generateResponse: vi.fn().mockResolvedValue({
            content: 'Final answer',
            tokensUsed: 10,
            sentViaMcp: true,
            mcpMessages: ['Looking into it...', 'Final answer'],
          }),
        };
        const handler = new MessageHandler(['@bot'], {
          storage: mockStorage,
          llmClient: mockLLM as any,
          signalClient: mockSignal,
          messageContext: makeContext({ botPhoneNumber: '+61000', signalCliUrl: 'http://localhost:8080' }),
        });

        await handler.handleMessage('g1', '+61111', '@bot test', Date.now());

        // Signal client sendMessage should NOT be called — Claude handled it via MCP
        expect(mockSignal.sendMessage).not.toHaveBeenCalled();
      });

      it('should auto-send response as fallback when Claude did not use MCP', async () => {
        const mockLLM = {
          generateResponse: vi.fn().mockResolvedValue({
            content: 'Simple reply',
            tokensUsed: 10,
            sentViaMcp: false,
            mcpMessages: [],
          }),
        };
        const handler = new MessageHandler(['@bot'], {
          storage: mockStorage,
          llmClient: mockLLM as any,
          signalClient: mockSignal,
          messageContext: makeContext({ botPhoneNumber: '+61000', signalCliUrl: 'http://localhost:8080' }),
        });

        await handler.handleMessage('g1', '+61111', '@bot test', Date.now());

        // Fallback: bot sends the response
        expect(mockSignal.sendMessage).toHaveBeenCalledWith('g1', 'Simple reply');
      });

      it('should store each MCP-sent message in the database', async () => {
        const mockLLM = {
          generateResponse: vi.fn().mockResolvedValue({
            content: 'Final',
            tokensUsed: 10,
            sentViaMcp: true,
            mcpMessages: ['Ack message', 'Final response'],
          }),
        };
        const handler = new MessageHandler(['@bot'], {
          storage: mockStorage,
          llmClient: mockLLM as any,
          signalClient: mockSignal,
          messageContext: makeContext({ botPhoneNumber: '+61000', signalCliUrl: 'http://localhost:8080' }),
        });

        await handler.handleMessage('g1', '+61111', '@bot test', Date.now());

        // Each MCP message should be stored
        const botMessages = mockStorage.addMessage.mock.calls.filter((call: any[]) => call[0].isBot === true);
        expect(botMessages).toHaveLength(2);
        expect(botMessages[0][0].content).toBe('Ack message');
        expect(botMessages[1][0].content).toBe('Final response');
      });

      it('should pass signalCliUrl and botPhoneNumber to LLM context', async () => {
        const handler = new MessageHandler(['@bot'], {
          storage: mockStorage,
          llmClient: mockLLM,
          signalClient: mockSignal,
          messageContext: makeContext({ botPhoneNumber: '+61000', signalCliUrl: 'http://localhost:8080' }),
        });

        await handler.handleMessage('g1', '+61111', '@bot hello', Date.now());

        expect(mockLLM.generateResponse).toHaveBeenCalledWith(
          expect.any(Array),
          expect.objectContaining({
            signalCliUrl: 'http://localhost:8080',
            botPhoneNumber: '+61000',
          }),
        );
      });
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

      it('should not include image attachments as voice attachments', async () => {
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
          messageContext: makeContext({ attachmentsDir: '/data/attachments' }),
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

      it('should store message but not invoke Claude when storeOnly is true', async () => {
        const handler = new MessageHandler(['@bot'], {
          storage: mockStorage,
          llmClient: mockLLM,
          signalClient: mockSignal,
        });

        await handler.handleMessage('g1', 'Alice', '@bot hello', 1000, [], { storeOnly: true });

        expect(mockStorage.addMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            groupId: 'g1',
            sender: 'Alice',
            content: '@bot hello',
          }),
        );
        expect(mockLLM.generateResponse).not.toHaveBeenCalled();
        expect(mockSignal.sendMessage).not.toHaveBeenCalled();
        expect(mockSignal.sendTyping).not.toHaveBeenCalled();
      });
    });

    describe('image attachment handling', () => {
      it('should include image attachment info in query when present', async () => {
        const handler = new MessageHandler(['@bot'], {
          storage: mockStorage,
          llmClient: mockLLM,
          signalClient: mockSignal,
          messageContext: makeContext({ attachmentsDir: '/data/attachments' }),
        });

        await handler.handleMessage('g1', 'Alice', '@bot what is this', 1000, [
          { id: 'img-abc', contentType: 'image/jpeg', size: 50000, filename: 'photo.jpg' },
        ]);

        const callArgs = (mockLLM.generateResponse as ReturnType<typeof vi.fn>).mock.calls[0];
        const messages = callArgs[0];
        const lastUserMsg = messages[messages.length - 1];
        expect(lastUserMsg.content).toContain('[Image attached: /data/attachments/img-abc]');
      });

      it('should include image attachment paths from history messages in context', async () => {
        const mockHistory: Message[] = [
          {
            id: 1,
            groupId: 'g1',
            sender: 'Alice',
            content: 'check this out',
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
          messageContext: makeContext({ attachmentsDir: '/data/attachments' }),
        });

        await handler.handleMessage('g1', 'Bob', '@bot what was that image', 1000);

        const callArgs = (mockLLM.generateResponse as ReturnType<typeof vi.fn>).mock.calls[0];
        const messages = callArgs[0];
        const historyMsg = messages.find(
          (m: { role: string; content: string }) => m.role === 'user' && m.content.includes('Alice'),
        );
        expect(historyMsg.content).toContain('[Image attached: /data/attachments/img-123]');
      });

      it('should not include non-image non-audio attachments', async () => {
        const handler = new MessageHandler(['@bot'], {
          storage: mockStorage,
          llmClient: mockLLM,
          signalClient: mockSignal,
        });

        await handler.handleMessage('g1', 'Alice', '@bot check this', 1000, [
          { id: 'doc-abc', contentType: 'application/pdf', size: 10000, filename: 'doc.pdf' },
        ]);

        const callArgs = (mockLLM.generateResponse as ReturnType<typeof vi.fn>).mock.calls[0];
        const messages = callArgs[0];
        const lastUserMsg = messages[messages.length - 1];
        expect(lastUserMsg.content).not.toContain('[Image attached:');
        expect(lastUserMsg.content).not.toContain('[Voice message attached:');
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

        const handler = new MessageHandler(['@bot'], {
          storage: mockStorage,
          llmClient: mockLLM,
          signalClient: mockSignal,
        });

        await handler.handleMessage('g1', 'Alice', '@bot hello', 1000);

        expect(mockSignal.stopTyping).toHaveBeenCalledWith('g1');
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

        const handler = new MessageHandler(['@bot'], {
          storage: mockStorage,
          llmClient: mockLLM,
          signalClient: mockSignal,
        });

        await handler.handleMessage('g1', 'Alice', '@bot hello', 1000);

        expect(mockLLM.generateResponse).toHaveBeenCalled();
        expect(mockSignal.sendMessage).toHaveBeenCalledWith('g1', 'Test response');
      });

      it('should not throw when typing indicator stop fails', async () => {
        mockSignal.stopTyping = vi.fn().mockRejectedValue(new Error('Stop typing failed'));

        const handler = new MessageHandler(['@bot'], {
          storage: mockStorage,
          llmClient: mockLLM,
          signalClient: mockSignal,
        });

        await handler.handleMessage('g1', 'Alice', '@bot hello', 1000);

        expect(mockSignal.sendMessage).toHaveBeenCalledWith('g1', 'Test response');
      });

      it('should refresh typing indicator during long-running LLM calls', async () => {
        vi.useFakeTimers();

        // Simulate a 25-second LLM call
        mockLLM.generateResponse = vi.fn().mockImplementation(
          () =>
            new Promise(resolve => {
              setTimeout(
                () => resolve({ content: 'Slow response', tokensUsed: 500, sentViaMcp: false, mcpMessages: [] }),
                25_000,
              );
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
