import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageHandler } from '../src/messageHandler';
import type { SignalClient } from '../src/signalClient';
import type { Storage } from '../src/storage';
import type { AppConfig, LLMClient } from '../src/types';

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
    botPhoneNumber: '',
    attachmentsDir: './data/signal-attachments',
    whisperModelPath: './models/ggml-base.en.bin',
    darkFactoryEnabled: '',
    darkFactoryProjectRoot: '',
    ...overrides,
  };
}

describe('MessageHandler maintenance', () => {
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
      getDistinctGroupIds: vi.fn().mockReturnValue(['g1', 'g2']),
      getDossiersByGroup: vi.fn().mockReturnValue([]),
      getMemoriesByGroup: vi.fn().mockReturnValue([]),
      getActivePersonaForGroup: vi.fn().mockReturnValue(null),
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
      fetchAttachment: vi.fn().mockResolvedValue(null),
      readAttachmentFile: vi.fn().mockReturnValue(null),
    } as any;
  });

  describe('runMaintenance', () => {
    it('should call trimMessages for all groups from getDistinctGroupIds', () => {
      const handler = new MessageHandler(
        ['@bot'],
        { storage: mockStorage, llmClient: mockLLM, signalClient: mockSignal },
        { messageRetentionCount: 500 },
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
        ['@bot'],
        { storage: mockStorage, llmClient: mockLLM, signalClient: mockSignal },
        { attachmentRetentionDays: 14 },
      );

      handler.runMaintenance();

      const expectedCutoff = mockNow - 14 * 24 * 60 * 60 * 1000;
      expect(mockStorage.trimAttachments).toHaveBeenCalledTimes(1);
      expect(mockStorage.trimAttachments).toHaveBeenCalledWith(expectedCutoff);

      vi.restoreAllMocks();
    });
  });

  describe('processLlmRequest trimming removal', () => {
    it('should NOT call trimMessages or trimAttachments during processLlmRequest', async () => {
      const handler = new MessageHandler(['@bot'], {
        storage: mockStorage,
        llmClient: mockLLM,
        signalClient: mockSignal,
      });

      await handler.handleMessage('g1', 'Alice', '@bot hello', 1000);

      expect(mockStorage.trimMessages).not.toHaveBeenCalled();
      expect(mockStorage.trimAttachments).not.toHaveBeenCalled();
    });
  });

  describe('attachment ingestion', () => {
    it('should ingest attachments when handleMessageBatch is called', async () => {
      const fakeBuffer = Buffer.from('fake image');
      mockSignal.fetchAttachment = vi.fn().mockResolvedValue(fakeBuffer);

      const handler = new MessageHandler(['@bot'], {
        storage: mockStorage,
        llmClient: mockLLM,
        signalClient: mockSignal,
        appConfig: makeAppConfig({ attachmentsDir: '/data/attachments' }),
      });

      await handler.handleMessageBatch('g1', [
        {
          sender: 'Alice',
          content: 'hello',
          timestamp: 1000,
          attachments: [{ id: 'img-abc', contentType: 'image/jpeg', size: 50000, filename: 'photo.jpg' }],
        },
      ]);

      expect(mockSignal.fetchAttachment).toHaveBeenCalledWith('img-abc');
      expect(mockStorage.saveAttachment).toHaveBeenCalled();
    });
  });
});
