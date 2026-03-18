import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageHandler } from '../src/messageHandler';
import type { SignalClient } from '../src/signalClient';
import type { Storage } from '../src/storage';
import type { AppConfig, LLMClient, MentionRequest, Message, QueueItem } from '../src/types';

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
    botPhoneNumber: '+61000',
    attachmentsDir: './data/signal-attachments',
    whisperModelPath: './models/ggml-base.en.bin',
    darkFactoryEnabled: '',
    darkFactoryProjectRoot: '',
    ...overrides,
  };
}

function makeSingleItem(overrides?: Partial<MentionRequest>): QueueItem {
  return {
    kind: 'single',
    request: {
      groupId: 'g1',
      sender: '+61400111222',
      content: '@bot hello',
      attachments: [],
      timestamp: 1000,
      ...overrides,
    },
  };
}

function makeCoalescedItem(requests: Partial<MentionRequest>[], missedFraming: string): QueueItem {
  return {
    kind: 'coalesced',
    requests: requests.map(r => ({
      groupId: 'g1',
      sender: '+61400111222',
      content: '@bot hello',
      attachments: [],
      timestamp: 1000,
      ...r,
    })),
    missedFraming,
  };
}

describe('MessageHandler', () => {
  let mockStorage: Storage;
  let mockLLM: LLMClient;
  let mockSignal: SignalClient;

  beforeEach(() => {
    vi.clearAllMocks();

    mockStorage = {
      addMessage: vi.fn(),
      getRecentMessages: vi.fn().mockReturnValue([]),
      trimMessages: vi.fn(),
      trimAttachments: vi.fn(),
      getDossiersByGroup: vi.fn().mockReturnValue([]),
      getMemoriesByGroup: vi.fn().mockReturnValue([]),
      getActivePersonaForGroup: vi.fn().mockReturnValue(null),
      getDistinctGroupIds: vi.fn().mockReturnValue(['g1']),
      saveAttachment: vi.fn(),
      groupSettings: {
        getToolNotifications: vi.fn().mockReturnValue(false),
        isEnabled: vi.fn().mockReturnValue(true),
        getTriggers: vi.fn().mockReturnValue(null),
      },
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
      readAttachmentFile: vi.fn().mockReturnValue(null),
    } as any;
  });

  describe('processRequest', () => {
    it('should fetch fresh history and invoke LLM', async () => {
      const mockHistory: Message[] = [
        { id: 1, groupId: 'g1', sender: 'Alice', content: 'Previous message', timestamp: 500, isBot: false },
      ];
      mockStorage.getRecentMessages = vi.fn().mockReturnValue(mockHistory);

      const handler = new MessageHandler(
        {
          storage: mockStorage,
          llmClient: mockLLM,
          signalClient: mockSignal,
          appConfig: makeAppConfig(),
        },
        { mentionTriggers: ['@bot'], contextWindowSize: 50 },
      );

      await handler.processRequest(makeSingleItem());

      expect(mockStorage.getRecentMessages).toHaveBeenCalledWith('g1', 50);
      expect(mockLLM.generateResponse).toHaveBeenCalled();
    });

    it('should filter the triggering message from history (single item)', async () => {
      const mockHistory: Message[] = [
        { id: 1, groupId: 'g1', sender: 'Alice', content: 'Previous message', timestamp: 500, isBot: false },
        { id: 2, groupId: 'g1', sender: '+61400111222', content: '@bot hello', timestamp: 1000, isBot: false },
      ];
      mockStorage.getRecentMessages = vi.fn().mockReturnValue(mockHistory);

      const handler = new MessageHandler(
        {
          storage: mockStorage,
          llmClient: mockLLM,
          signalClient: mockSignal,
          appConfig: makeAppConfig(),
        },
        { mentionTriggers: ['@bot'] },
      );

      await handler.processRequest(makeSingleItem({ sender: '+61400111222', timestamp: 1000 }));

      // The LLM should receive history without the triggering message
      const callArgs = (mockLLM.generateResponse as ReturnType<typeof vi.fn>).mock.calls[0];
      const messages = callArgs[0];
      const historyMsgs = messages.filter(
        (m: { role: string; content: string }) => m.role === 'user' && m.content.includes('Previous message'),
      );
      expect(historyMsgs).toHaveLength(1);

      // The triggering message should not appear in history context
      const triggerInHistory = messages.filter(
        (m: { role: string; content: string }) =>
          m.role === 'user' &&
          m.content.includes('[') &&
          m.content.includes('+61400111222') &&
          m.content.includes('@bot hello'),
      );
      expect(triggerInHistory).toHaveLength(0);
    });

    it('should send response to group', async () => {
      const handler = new MessageHandler(
        {
          storage: mockStorage,
          llmClient: mockLLM,
          signalClient: mockSignal,
          appConfig: makeAppConfig(),
        },
        { mentionTriggers: ['@bot'] },
      );

      await handler.processRequest(makeSingleItem());

      expect(mockSignal.sendMessage).toHaveBeenCalledWith('g1', 'Test response');
    });

    it('should store bot response', async () => {
      vi.spyOn(Date, 'now').mockReturnValue(2000);

      const handler = new MessageHandler(
        {
          storage: mockStorage,
          llmClient: mockLLM,
          signalClient: mockSignal,
          appConfig: makeAppConfig(),
        },
        { mentionTriggers: ['@bot'] },
      );

      await handler.processRequest(makeSingleItem());

      expect(mockStorage.addMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          groupId: 'g1',
          content: 'Test response',
          timestamp: 2000,
          isBot: true,
          sender: '+61000',
        }),
      );
    });

    it('should handle coalesced items with missed framing', async () => {
      const missedFraming =
        'You were offline and missed the following messages:\n- [+61400111222] (2 min ago): "question one"\n- [+61400333444] (1 min ago): "question two"\n\nRespond to all of these in a single message.';
      const item = makeCoalescedItem(
        [
          { content: '@bot question one', sender: '+61400111222', timestamp: 900 },
          { content: '@bot question two', sender: '+61400333444', timestamp: 1000 },
        ],
        missedFraming,
      );

      const handler = new MessageHandler(
        {
          storage: mockStorage,
          llmClient: mockLLM,
          signalClient: mockSignal,
          appConfig: makeAppConfig(),
        },
        { mentionTriggers: ['@bot'] },
      );

      await handler.processRequest(item);

      // Should use the last request's content for the query
      const callArgs = (mockLLM.generateResponse as ReturnType<typeof vi.fn>).mock.calls[0];
      const messages = callArgs[0];
      const lastUserMsg = messages[messages.length - 1];
      expect(lastUserMsg.content).toContain('You were offline and missed the following messages:');
      expect(lastUserMsg.content).toContain('question two');
    });

    it('should filter all triggering messages from history for coalesced items', async () => {
      const mockHistory: Message[] = [
        { id: 1, groupId: 'g1', sender: 'Alice', content: 'Unrelated', timestamp: 500, isBot: false },
        { id: 2, groupId: 'g1', sender: '+61400111222', content: '@bot question one', timestamp: 900, isBot: false },
        { id: 3, groupId: 'g1', sender: '+61400333444', content: '@bot question two', timestamp: 1000, isBot: false },
      ];
      mockStorage.getRecentMessages = vi.fn().mockReturnValue(mockHistory);

      const missedFraming = 'You were offline and missed the following messages:';
      const item = makeCoalescedItem(
        [
          { content: '@bot question one', sender: '+61400111222', timestamp: 900 },
          { content: '@bot question two', sender: '+61400333444', timestamp: 1000 },
        ],
        missedFraming,
      );

      const handler = new MessageHandler(
        {
          storage: mockStorage,
          llmClient: mockLLM,
          signalClient: mockSignal,
          appConfig: makeAppConfig(),
        },
        { mentionTriggers: ['@bot'] },
      );

      await handler.processRequest(item);

      const callArgs = (mockLLM.generateResponse as ReturnType<typeof vi.fn>).mock.calls[0];
      const messages = callArgs[0];
      // Only the unrelated message should be in history (plus system + query)
      const userHistoryMsgs = messages.filter(
        (m: { role: string; content: string }) => m.role === 'user' && m.content.includes('Unrelated'),
      );
      expect(userHistoryMsgs).toHaveLength(1);

      // Trigger messages should not be in history
      const triggerMsgs = messages.filter(
        (m: { role: string; content: string }) =>
          m.role === 'user' && m.content.includes('question one') && m.content.includes('['),
      );
      expect(triggerMsgs).toHaveLength(0);
    });

    it('should send error message on LLM failure', async () => {
      const { logger } = await import('../src/logger');
      mockLLM.generateResponse = vi.fn().mockRejectedValue(new Error('LLM API error'));

      const handler = new MessageHandler(
        {
          storage: mockStorage,
          llmClient: mockLLM,
          signalClient: mockSignal,
          appConfig: makeAppConfig(),
        },
        { mentionTriggers: ['@bot'] },
      );

      await handler.processRequest(makeSingleItem());

      expect(logger.error).toHaveBeenCalled();
      expect(mockSignal.sendMessage).toHaveBeenCalledWith(
        'g1',
        'Sorry, I encountered an error processing your request.',
      );
    });

    it('should extract query by stripping mention trigger', async () => {
      const handler = new MessageHandler(
        {
          storage: mockStorage,
          llmClient: mockLLM,
          signalClient: mockSignal,
          appConfig: makeAppConfig(),
        },
        { mentionTriggers: ['@bot'] },
      );

      await handler.processRequest(makeSingleItem({ content: '@bot what is 2+2?' }));

      const callArgs = (mockLLM.generateResponse as ReturnType<typeof vi.fn>).mock.calls[0];
      const messages = callArgs[0];
      const lastUserMsg = messages[messages.length - 1];
      expect(lastUserMsg.content).toContain('what is 2+2?');
      expect(lastUserMsg.content).not.toMatch(/^@bot/);
    });

    it('should include voice attachment info in query when present', async () => {
      const handler = new MessageHandler(
        {
          storage: mockStorage,
          llmClient: mockLLM,
          signalClient: mockSignal,
          appConfig: makeAppConfig(),
        },
        { mentionTriggers: ['@bot'] },
      );

      await handler.processRequest(
        makeSingleItem({
          content: '@bot',
          attachments: [{ id: 'voice-abc', contentType: 'audio/aac', size: 5000, filename: null }],
        }),
      );

      const callArgs = (mockLLM.generateResponse as ReturnType<typeof vi.fn>).mock.calls[0];
      const messages = callArgs[0];
      const lastUserMsg = messages[messages.length - 1];
      expect(lastUserMsg.content).toContain('[Voice message attached:');
      expect(lastUserMsg.content).toContain('voice-abc');
    });

    it('should include image attachment info in query when present', async () => {
      const handler = new MessageHandler(
        {
          storage: mockStorage,
          llmClient: mockLLM,
          signalClient: mockSignal,
          appConfig: makeAppConfig({ attachmentsDir: '/data/attachments' }),
        },
        { mentionTriggers: ['@bot'] },
      );

      await handler.processRequest(
        makeSingleItem({
          content: '@bot what is this',
          attachments: [{ id: 'img-abc', contentType: 'image/jpeg', size: 50000, filename: 'photo.jpg' }],
        }),
      );

      const callArgs = (mockLLM.generateResponse as ReturnType<typeof vi.fn>).mock.calls[0];
      const messages = callArgs[0];
      const lastUserMsg = messages[messages.length - 1];
      expect(lastUserMsg.content).toContain('[Image: attachment://img-abc]');
    });

    it('should not auto-send response when Claude sent messages via MCP', async () => {
      const mcpLLM: LLMClient = {
        generateResponse: vi.fn().mockResolvedValue({
          content: 'Final answer',
          tokensUsed: 10,
          sentViaMcp: true,
          mcpMessages: ['Looking into it...', 'Final answer'],
        }),
      };

      const handler = new MessageHandler(
        {
          storage: mockStorage,
          llmClient: mcpLLM,
          signalClient: mockSignal,
          appConfig: makeAppConfig(),
        },
        { mentionTriggers: ['@bot'] },
      );

      await handler.processRequest(makeSingleItem());

      // Signal client sendMessage should NOT be called -- Claude handled it via MCP
      expect(mockSignal.sendMessage).not.toHaveBeenCalled();
    });

    it('should store each MCP-sent message in the database', async () => {
      const mcpLLM: LLMClient = {
        generateResponse: vi.fn().mockResolvedValue({
          content: 'Final',
          tokensUsed: 10,
          sentViaMcp: true,
          mcpMessages: ['Ack message', 'Final response'],
        }),
      };

      const handler = new MessageHandler(
        {
          storage: mockStorage,
          llmClient: mcpLLM,
          signalClient: mockSignal,
          appConfig: makeAppConfig(),
        },
        { mentionTriggers: ['@bot'] },
      );

      await handler.processRequest(makeSingleItem());

      // Each MCP message should be stored
      const botMessages = (mockStorage.addMessage as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: any[]) => call[0].isBot === true,
      );
      expect(botMessages).toHaveLength(2);
      expect(botMessages[0][0].content).toBe('Ack message');
      expect(botMessages[1][0].content).toBe('Final response');
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
      ]);

      const handler = new MessageHandler(
        {
          storage: mockStorage,
          llmClient: mockLLM,
          signalClient: mockSignal,
          appConfig: makeAppConfig(),
        },
        { mentionTriggers: ['@bot'] },
      );

      await handler.processRequest(makeSingleItem());

      expect(mockStorage.getDossiersByGroup).toHaveBeenCalledWith('g1');
      const callArgs = (mockLLM.generateResponse as ReturnType<typeof vi.fn>).mock.calls[0];
      const messages = callArgs[0];
      const systemMsg = messages.find((m: { role: string }) => m.role === 'system');
      expect(systemMsg.content).toContain('## People in this group');
      expect(systemMsg.content).toContain('Alice (+61400000001)');
      expect(systemMsg.content).toContain('Loves cats');
    });

    it('should use active persona description in system prompt', async () => {
      mockStorage.getActivePersonaForGroup = vi.fn().mockReturnValue({
        id: 2,
        name: 'Pirate',
        description: 'Ye be a pirate captain! Speak in pirate dialect.',
        tags: 'fun,pirate',
        isDefault: false,
        createdAt: 1000,
        updatedAt: 1000,
      });

      const handler = new MessageHandler(
        {
          storage: mockStorage,
          llmClient: mockLLM,
          signalClient: mockSignal,
          appConfig: makeAppConfig(),
        },
        { systemPrompt: 'Default assistant prompt.', mentionTriggers: ['@bot'] },
      );

      await handler.processRequest(makeSingleItem());

      const callArgs = (mockLLM.generateResponse as ReturnType<typeof vi.fn>).mock.calls[0];
      const messages = callArgs[0];
      const systemMsg = messages.find((m: { role: string }) => m.role === 'system');
      expect(systemMsg.content).toContain('Ye be a pirate captain!');
      expect(systemMsg.content).not.toContain('Default assistant prompt.');
    });

    it('should pass appConfig fields to LLM context', async () => {
      const handler = new MessageHandler(
        {
          storage: mockStorage,
          llmClient: mockLLM,
          signalClient: mockSignal,
          appConfig: makeAppConfig({ signalCliUrl: 'http://localhost:8080' }),
        },
        { mentionTriggers: ['@bot'] },
      );

      await handler.processRequest(makeSingleItem());

      expect(mockLLM.generateResponse).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          signalCliUrl: 'http://localhost:8080',
          botPhoneNumber: '+61000',
          groupId: 'g1',
          sender: '+61400111222',
        }),
      );
    });

    it('should resolve sender IDs to display names in history using dossier data', async () => {
      const mockHistory: Message[] = [
        { id: 1, groupId: 'g1', sender: '+61400000001', content: 'Previous message', timestamp: 500, isBot: false },
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
      ]);

      const handler = new MessageHandler(
        {
          storage: mockStorage,
          llmClient: mockLLM,
          signalClient: mockSignal,
          appConfig: makeAppConfig(),
        },
        { mentionTriggers: ['@bot'] },
      );

      await handler.processRequest(makeSingleItem());

      const callArgs = (mockLLM.generateResponse as ReturnType<typeof vi.fn>).mock.calls[0];
      const messages = callArgs[0];
      const aliceMsg = messages.find(
        (m: { role: string; content: string }) => m.role === 'user' && m.content.includes('Previous message'),
      );
      expect(aliceMsg.content).toContain('Alice: Previous message');
      expect(aliceMsg.content).not.toContain('+61400000001');
    });
  });

  describe('runMaintenance', () => {
    it('should call trimMessages for all groups from getDistinctGroupIds', () => {
      mockStorage.getDistinctGroupIds = vi.fn().mockReturnValue(['g1', 'g2']);

      const handler = new MessageHandler(
        {
          storage: mockStorage,
          llmClient: mockLLM,
          signalClient: mockSignal,
          appConfig: makeAppConfig(),
        },
        { messageRetentionCount: 500, mentionTriggers: ['@bot'] },
      );

      handler.runMaintenance();

      expect(mockStorage.getDistinctGroupIds).toHaveBeenCalled();
      expect(mockStorage.trimMessages).toHaveBeenCalledTimes(2);
      expect(mockStorage.trimMessages).toHaveBeenCalledWith('g1', 500);
      expect(mockStorage.trimMessages).toHaveBeenCalledWith('g2', 500);
    });

    it('should call trimAttachments with correct cutoff', () => {
      const mockNow = 1700000000000;
      vi.spyOn(Date, 'now').mockReturnValue(mockNow);

      const handler = new MessageHandler(
        {
          storage: mockStorage,
          llmClient: mockLLM,
          signalClient: mockSignal,
          appConfig: makeAppConfig(),
        },
        { attachmentRetentionDays: 14, mentionTriggers: ['@bot'] },
      );

      handler.runMaintenance();

      const expectedCutoff = mockNow - 14 * 24 * 60 * 60 * 1000;
      expect(mockStorage.trimAttachments).toHaveBeenCalledTimes(1);
      expect(mockStorage.trimAttachments).toHaveBeenCalledWith(expectedCutoff);

      vi.restoreAllMocks();
    });

    it('should handle trimMessages errors gracefully', async () => {
      const { logger } = await import('../src/logger');
      mockStorage.getDistinctGroupIds = vi.fn().mockReturnValue(['g1']);
      mockStorage.trimMessages = vi.fn().mockImplementation(() => {
        throw new Error('trim failed');
      });

      const handler = new MessageHandler(
        {
          storage: mockStorage,
          llmClient: mockLLM,
          signalClient: mockSignal,
          appConfig: makeAppConfig(),
        },
        { mentionTriggers: ['@bot'] },
      );

      handler.runMaintenance();

      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Failed to trim messages'), expect.any(Error));
    });
  });
});
