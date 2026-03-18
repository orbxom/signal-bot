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
      groupSettings: { getToolNotifications: vi.fn().mockReturnValue(false) },
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

  describe('store-only attachment ingestion', () => {
    it('should NOT ingest attachments when handleMessageBatch is called with storeOnly: true', async () => {
      const fakeBuffer = Buffer.from('fake image');
      mockSignal.readAttachmentFile = vi.fn().mockReturnValue({ data: fakeBuffer });

      const handler = new MessageHandler(['@bot'], {
        storage: mockStorage,
        llmClient: mockLLM,
        signalClient: mockSignal,
        appConfig: makeAppConfig({ attachmentsDir: '/data/attachments' }),
      });

      await handler.handleMessageBatch(
        'g1',
        [
          {
            sender: 'Alice',
            content: '@bot check this',
            timestamp: 1000,
            attachments: [{ id: 'img-abc', contentType: 'image/jpeg', size: 50000, filename: 'photo.jpg' }],
          },
        ],
        { storeOnly: true },
      );

      expect(mockSignal.readAttachmentFile).not.toHaveBeenCalled();
      expect(mockStorage.saveAttachment).not.toHaveBeenCalled();
    });

    it('should ingest attachments when handleMessageBatch is called with storeOnly: false', async () => {
      const fakeBuffer = Buffer.from('fake image');
      mockSignal.readAttachmentFile = vi.fn().mockReturnValue({ data: fakeBuffer });

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

      expect(mockSignal.readAttachmentFile).toHaveBeenCalledWith('/data/attachments', 'img-abc');
      expect(mockStorage.saveAttachment).toHaveBeenCalled();
    });

    it('should NOT ingest attachments when handleMessage is called with storeOnly: true', async () => {
      const fakeBuffer = Buffer.from('fake image');
      mockSignal.readAttachmentFile = vi.fn().mockReturnValue({ data: fakeBuffer });

      const handler = new MessageHandler(['@bot'], {
        storage: mockStorage,
        llmClient: mockLLM,
        signalClient: mockSignal,
        appConfig: makeAppConfig({ attachmentsDir: '/data/attachments' }),
      });

      await handler.handleMessage(
        'g1',
        'Alice',
        '@bot check this',
        1000,
        [{ id: 'img-abc', contentType: 'image/jpeg', size: 50000, filename: 'photo.jpg' }],
        { storeOnly: true },
      );

      expect(mockSignal.readAttachmentFile).not.toHaveBeenCalled();
      expect(mockStorage.saveAttachment).not.toHaveBeenCalled();
    });
  });
});
