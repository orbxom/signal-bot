import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageDeduplicator } from '../src/messageDeduplicator';
import { ingestMessages } from '../src/messageIngestion';
import type { SignalClient } from '../src/signalClient';
import type { Storage } from '../src/storage';
import type { ExtractedMessage, QueueItem } from '../src/types';

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

describe('ingestMessages', () => {
  let mockStorage: Storage;
  let mockSignal: SignalClient;
  let enqueuedItems: QueueItem[];

  beforeEach(() => {
    vi.clearAllMocks();
    enqueuedItems = [];

    mockStorage = {
      addMessage: vi.fn(),
      saveAttachment: vi.fn(),
      groupSettings: {
        isEnabled: vi.fn().mockReturnValue(true),
        getTriggers: vi.fn().mockReturnValue(null),
        getToolNotifications: vi.fn().mockReturnValue(false),
      },
    } as any;

    mockSignal = {
      readAttachmentFile: vi.fn().mockReturnValue(null),
    } as any;
  });

  function makeMsg(overrides?: Partial<ExtractedMessage>): ExtractedMessage {
    return {
      sender: '+61400111222',
      content: 'hello',
      groupId: 'g1',
      timestamp: Date.now(),
      attachments: [],
      ...overrides,
    };
  }

  it('should store all messages', () => {
    const messages = [makeMsg({ content: 'hey' }), makeMsg({ content: 'hi' })];
    ingestMessages({
      messages,
      mentionTriggers: ['@bot'],
      botPhoneNumber: '+61000',
      storage: mockStorage,
      signalClient: mockSignal,
      enqueue: item => enqueuedItems.push(item),
    });

    expect(mockStorage.addMessage).toHaveBeenCalledTimes(2);
  });

  it('should skip bot-self messages', () => {
    const messages = [makeMsg({ sender: '+61000', content: '@bot hello' })];
    ingestMessages({
      messages,
      mentionTriggers: ['@bot'],
      botPhoneNumber: '+61000',
      storage: mockStorage,
      signalClient: mockSignal,
      enqueue: item => enqueuedItems.push(item),
    });

    expect(mockStorage.addMessage).not.toHaveBeenCalled();
    expect(enqueuedItems).toHaveLength(0);
  });

  it('should enqueue mentions as single QueueItems', () => {
    const messages = [makeMsg({ content: '@bot hello', timestamp: Date.now() })];
    ingestMessages({
      messages,
      mentionTriggers: ['@bot'],
      botPhoneNumber: '+61000',
      storage: mockStorage,
      signalClient: mockSignal,
      enqueue: item => enqueuedItems.push(item),
    });

    expect(enqueuedItems).toHaveLength(1);
    expect(enqueuedItems[0].kind).toBe('single');
  });

  it('should not enqueue non-mention messages', () => {
    const messages = [makeMsg({ content: 'just chatting' })];
    ingestMessages({
      messages,
      mentionTriggers: ['@bot'],
      botPhoneNumber: '+61000',
      storage: mockStorage,
      signalClient: mockSignal,
      enqueue: item => enqueuedItems.push(item),
    });

    expect(enqueuedItems).toHaveLength(0);
  });

  it('should not enqueue for disabled groups', () => {
    (mockStorage.groupSettings.isEnabled as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const messages = [makeMsg({ content: '@bot hello' })];
    ingestMessages({
      messages,
      mentionTriggers: ['@bot'],
      botPhoneNumber: '+61000',
      storage: mockStorage,
      signalClient: mockSignal,
      enqueue: item => enqueuedItems.push(item),
    });

    expect(mockStorage.addMessage).toHaveBeenCalledTimes(1); // still stored
    expect(enqueuedItems).toHaveLength(0); // but not enqueued
  });

  it('should not enqueue for storeOnly groups', () => {
    const messages = [makeMsg({ content: '@bot hello' })];
    ingestMessages({
      messages,
      mentionTriggers: ['@bot'],
      botPhoneNumber: '+61000',
      storage: mockStorage,
      signalClient: mockSignal,
      enqueue: item => enqueuedItems.push(item),
      storeOnlyGroupIds: new Set(['g1']),
    });

    expect(mockStorage.addMessage).toHaveBeenCalledTimes(1);
    expect(enqueuedItems).toHaveLength(0);
  });

  it('should not ingest attachments for storeOnly groups', () => {
    const messages = [
      makeMsg({
        content: 'hello',
        attachments: [{ id: 'att1', contentType: 'image/png', size: 1024, filename: 'pic.png' }],
      }),
    ];
    (mockSignal.readAttachmentFile as ReturnType<typeof vi.fn>).mockReturnValue({ data: Buffer.from('img') });

    ingestMessages({
      messages,
      mentionTriggers: ['@bot'],
      botPhoneNumber: '+61000',
      storage: mockStorage,
      signalClient: mockSignal,
      enqueue: item => enqueuedItems.push(item),
      storeOnlyGroupIds: new Set(['g1']),
      attachmentsDir: '/tmp/attachments',
    });

    expect(mockStorage.saveAttachment).not.toHaveBeenCalled();
  });

  it('should not ingest attachments for disabled groups', () => {
    (mockStorage.groupSettings.isEnabled as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const messages = [
      makeMsg({
        content: 'hello',
        attachments: [{ id: 'att1', contentType: 'image/png', size: 1024, filename: 'pic.png' }],
      }),
    ];
    (mockSignal.readAttachmentFile as ReturnType<typeof vi.fn>).mockReturnValue({ data: Buffer.from('img') });

    ingestMessages({
      messages,
      mentionTriggers: ['@bot'],
      botPhoneNumber: '+61000',
      storage: mockStorage,
      signalClient: mockSignal,
      enqueue: item => enqueuedItems.push(item),
      attachmentsDir: '/tmp/attachments',
    });

    expect(mockStorage.saveAttachment).not.toHaveBeenCalled();
  });

  it('should ingest image attachments for enabled non-storeOnly groups', () => {
    const messages = [
      makeMsg({
        content: 'hello',
        attachments: [{ id: 'att1', contentType: 'image/png', size: 1024, filename: 'pic.png' }],
      }),
    ];
    (mockSignal.readAttachmentFile as ReturnType<typeof vi.fn>).mockReturnValue({ data: Buffer.from('img') });

    ingestMessages({
      messages,
      mentionTriggers: ['@bot'],
      botPhoneNumber: '+61000',
      storage: mockStorage,
      signalClient: mockSignal,
      enqueue: item => enqueuedItems.push(item),
      attachmentsDir: '/tmp/attachments',
    });

    expect(mockStorage.saveAttachment).toHaveBeenCalledTimes(1);
    expect(mockStorage.saveAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'att1',
        groupId: 'g1',
        contentType: 'image/png',
      }),
    );
  });

  it('should skip non-image attachments', () => {
    const messages = [
      makeMsg({
        content: 'hello',
        attachments: [{ id: 'att1', contentType: 'audio/mp3', size: 1024, filename: 'song.mp3' }],
      }),
    ];

    ingestMessages({
      messages,
      mentionTriggers: ['@bot'],
      botPhoneNumber: '+61000',
      storage: mockStorage,
      signalClient: mockSignal,
      enqueue: item => enqueuedItems.push(item),
      attachmentsDir: '/tmp/attachments',
    });

    expect(mockSignal.readAttachmentFile).not.toHaveBeenCalled();
    expect(mockStorage.saveAttachment).not.toHaveBeenCalled();
  });

  it('should use per-group custom triggers when available', () => {
    (mockStorage.groupSettings.getTriggers as ReturnType<typeof vi.fn>).mockReturnValue(['hey bot']);
    const messages = [makeMsg({ content: 'hey bot do stuff' })];
    ingestMessages({
      messages,
      mentionTriggers: ['@bot'],
      botPhoneNumber: '+61000',
      storage: mockStorage,
      signalClient: mockSignal,
      enqueue: item => enqueuedItems.push(item),
    });

    expect(enqueuedItems).toHaveLength(1);
  });

  it('should not trigger on default triggers when custom triggers are set', () => {
    (mockStorage.groupSettings.getTriggers as ReturnType<typeof vi.fn>).mockReturnValue(['hey bot']);
    const messages = [makeMsg({ content: '@bot hello' })];
    ingestMessages({
      messages,
      mentionTriggers: ['@bot'],
      botPhoneNumber: '+61000',
      storage: mockStorage,
      signalClient: mockSignal,
      enqueue: item => enqueuedItems.push(item),
    });

    expect(enqueuedItems).toHaveLength(0);
  });

  it('should coalesce multiple missed mentions into a single queue item', () => {
    const now = Date.now();
    const messages = [
      makeMsg({ content: '@bot first', timestamp: now - 60000, sender: 'Alice' }),
      makeMsg({ content: '@bot second', timestamp: now - 30000, sender: 'Bob' }),
    ];
    ingestMessages({
      messages,
      mentionTriggers: ['@bot'],
      botPhoneNumber: '+61000',
      storage: mockStorage,
      signalClient: mockSignal,
      enqueue: item => enqueuedItems.push(item),
      realtimeThresholdMs: 5000,
    });

    expect(enqueuedItems).toHaveLength(1);
    expect(enqueuedItems[0].kind).toBe('coalesced');
    if (enqueuedItems[0].kind === 'coalesced') {
      expect(enqueuedItems[0].requests).toHaveLength(2);
      expect(enqueuedItems[0].missedFraming).toContain('missed');
    }
  });

  it('should enqueue a single missed mention as a single item (not coalesced)', () => {
    const now = Date.now();
    const messages = [makeMsg({ content: '@bot hello', timestamp: now - 60000 })];
    ingestMessages({
      messages,
      mentionTriggers: ['@bot'],
      botPhoneNumber: '+61000',
      storage: mockStorage,
      signalClient: mockSignal,
      enqueue: item => enqueuedItems.push(item),
      realtimeThresholdMs: 5000,
    });

    expect(enqueuedItems).toHaveLength(1);
    expect(enqueuedItems[0].kind).toBe('single');
  });

  it('should handle mixed missed and realtime mentions', () => {
    const now = Date.now();
    const messages = [
      makeMsg({ content: '@bot old question 1', timestamp: now - 60000 }),
      makeMsg({ content: '@bot old question 2', timestamp: now - 30000 }),
      makeMsg({ content: '@bot new question', timestamp: now }),
    ];
    ingestMessages({
      messages,
      mentionTriggers: ['@bot'],
      botPhoneNumber: '+61000',
      storage: mockStorage,
      signalClient: mockSignal,
      enqueue: item => enqueuedItems.push(item),
      realtimeThresholdMs: 5000,
    });

    // 1 coalesced for the 2 missed + 1 single for the realtime
    expect(enqueuedItems).toHaveLength(2);
    expect(enqueuedItems[0].kind).toBe('coalesced');
    expect(enqueuedItems[1].kind).toBe('single');
  });

  it('should process realtime mentions individually', () => {
    const now = Date.now();
    const messages = [
      makeMsg({ content: '@bot hi', sender: '+111', timestamp: now }),
      makeMsg({ content: '@bot hey', sender: '+222', timestamp: now + 100 }),
    ];
    ingestMessages({
      messages,
      mentionTriggers: ['@bot'],
      botPhoneNumber: '+61000',
      storage: mockStorage,
      signalClient: mockSignal,
      enqueue: item => enqueuedItems.push(item),
      realtimeThresholdMs: 5000,
    });

    expect(enqueuedItems).toHaveLength(2);
    expect(enqueuedItems[0].kind).toBe('single');
    expect(enqueuedItems[1].kind).toBe('single');
  });

  it('should use deduplicator when provided', () => {
    const deduplicator = new MessageDeduplicator();
    const ts = Date.now();
    const messages = [
      makeMsg({ content: '@bot hello', sender: '+111', timestamp: ts }),
      makeMsg({ content: '@bot hello', sender: '+111', timestamp: ts }), // duplicate
    ];
    ingestMessages({
      messages,
      mentionTriggers: ['@bot'],
      botPhoneNumber: '+61000',
      storage: mockStorage,
      signalClient: mockSignal,
      enqueue: item => enqueuedItems.push(item),
      deduplicator,
    });

    expect(mockStorage.addMessage).toHaveBeenCalledTimes(1);
    expect(enqueuedItems).toHaveLength(1);
  });

  it('should group messages by groupId', () => {
    const messages = [
      makeMsg({ content: '@bot hello', groupId: 'g1' }),
      makeMsg({ content: 'hey', groupId: 'g2' }),
      makeMsg({ content: '@bot world', groupId: 'g1' }),
    ];
    ingestMessages({
      messages,
      mentionTriggers: ['@bot'],
      botPhoneNumber: '+61000',
      storage: mockStorage,
      signalClient: mockSignal,
      enqueue: item => enqueuedItems.push(item),
    });

    expect(mockStorage.addMessage).toHaveBeenCalledTimes(3);
    // Both g1 messages are @bot mentions with recent timestamps (realtime)
    expect(enqueuedItems).toHaveLength(2);
  });

  it('should include correct fields in MentionRequest', () => {
    const ts = Date.now();
    const messages = [
      makeMsg({
        content: '@bot hello',
        sender: '+111',
        groupId: 'g1',
        timestamp: ts,
        attachments: [{ id: 'att1', contentType: 'image/png', size: 100, filename: null }],
      }),
    ];
    ingestMessages({
      messages,
      mentionTriggers: ['@bot'],
      botPhoneNumber: '+61000',
      storage: mockStorage,
      signalClient: mockSignal,
      enqueue: item => enqueuedItems.push(item),
    });

    expect(enqueuedItems).toHaveLength(1);
    if (enqueuedItems[0].kind === 'single') {
      const req = enqueuedItems[0].request;
      expect(req.groupId).toBe('g1');
      expect(req.sender).toBe('+111');
      expect(req.content).toBe('@bot hello');
      expect(req.timestamp).toBe(ts);
      expect(req.attachments).toHaveLength(1);
      expect(req.attachments[0].id).toBe('att1');
    }
  });

  it('should include missedFraming with time-ago strings in coalesced items', () => {
    const now = Date.now();
    const messages = [
      makeMsg({ content: '@bot first', timestamp: now - 120000, sender: 'Alice' }),
      makeMsg({ content: '@bot second', timestamp: now - 30000, sender: 'Bob' }),
    ];
    ingestMessages({
      messages,
      mentionTriggers: ['@bot'],
      botPhoneNumber: '+61000',
      storage: mockStorage,
      signalClient: mockSignal,
      enqueue: item => enqueuedItems.push(item),
      realtimeThresholdMs: 5000,
    });

    expect(enqueuedItems).toHaveLength(1);
    if (enqueuedItems[0].kind === 'coalesced') {
      const framing = enqueuedItems[0].missedFraming;
      expect(framing).toContain('You were offline and missed the following messages:');
      expect(framing).toContain('Alice');
      expect(framing).toContain('Bob');
      expect(framing).toContain('min ago');
      expect(framing).toContain('Respond to all of these in a single message.');
    }
  });

  it('should not skip attachments when attachmentsDir is not provided', () => {
    const messages = [
      makeMsg({
        content: 'hello',
        attachments: [{ id: 'att1', contentType: 'image/png', size: 1024, filename: 'pic.png' }],
      }),
    ];

    ingestMessages({
      messages,
      mentionTriggers: ['@bot'],
      botPhoneNumber: '+61000',
      storage: mockStorage,
      signalClient: mockSignal,
      enqueue: item => enqueuedItems.push(item),
      // no attachmentsDir
    });

    // Without attachmentsDir, attachment ingestion is skipped
    expect(mockSignal.readAttachmentFile).not.toHaveBeenCalled();
    expect(mockStorage.saveAttachment).not.toHaveBeenCalled();
  });
});
