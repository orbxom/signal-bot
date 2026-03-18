import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DbPoller } from '../../src/services/dbPoller';

describe('DbPoller', () => {
  let dbPoller: DbPoller;
  let mockStorage: any;
  let mockWsHub: any;
  let mockPrepare: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockPrepare = vi.fn();
    mockStorage = {
      conn: {
        db: {
          prepare: mockPrepare,
        },
      },
    };
    mockWsHub = {
      broadcast: vi.fn(),
    };

    // Default: all queries return empty/zero
    mockPrepare.mockReturnValue({
      get: vi.fn().mockReturnValue({ maxId: 0 }),
      all: vi.fn().mockReturnValue([]),
    });

    dbPoller = new DbPoller(mockStorage, mockWsHub);
  });

  afterEach(() => {
    dbPoller.stop();
    vi.useRealTimers();
  });

  it('initializes high-water marks on start', () => {
    const getMock = vi.fn()
      .mockReturnValueOnce({ maxId: 10 })  // messages
      .mockReturnValueOnce({ maxId: 5 })   // sent reminders
      .mockReturnValueOnce({ maxId: 3 });  // failed reminders
    mockPrepare.mockReturnValue({ get: getMock, all: vi.fn().mockReturnValue([]) });

    dbPoller.start();

    expect(mockPrepare).toHaveBeenCalledWith('SELECT MAX(rowid) as maxId FROM messages');
    expect(mockPrepare).toHaveBeenCalledWith('SELECT MAX(rowid) as maxId FROM reminders WHERE status = ?');
  });

  it('polls on interval and broadcasts new messages', () => {
    const getMock = vi.fn().mockReturnValue({ maxId: 0 });
    const allMock = vi.fn().mockReturnValue([]);
    mockPrepare.mockReturnValue({ get: getMock, all: allMock });

    dbPoller.start();

    // After start, set up poll to return a message
    allMock.mockReturnValueOnce([
      { rowid: 1, groupId: 'g1', sender: '+123', content: 'hello', timestamp: 1000, isBot: 0 },
    ]).mockReturnValue([]);

    vi.advanceTimersByTime(2500);

    expect(mockWsHub.broadcast).toHaveBeenCalledWith({
      type: 'message:new',
      data: {
        groupId: 'g1',
        sender: '+123',
        preview: 'hello',
        timestamp: 1000,
        isBot: false,
      },
    });
  });

  it('broadcasts reminder:due events for sent reminders', () => {
    const getMock = vi.fn().mockReturnValue({ maxId: 0 });
    const allMock = vi.fn().mockReturnValue([]);
    mockPrepare.mockReturnValue({ get: getMock, all: allMock });

    dbPoller.start();

    // First poll: messages returns empty, then sent reminders return one
    allMock
      .mockReturnValueOnce([]) // messages
      .mockReturnValueOnce([{ rowid: 1, id: 42, groupId: 'g1', reminderText: 'Take meds' }]) // sent
      .mockReturnValue([]); // failed

    vi.advanceTimersByTime(2500);

    expect(mockWsHub.broadcast).toHaveBeenCalledWith({
      type: 'reminder:due',
      data: { id: 42, groupId: 'g1', text: 'Take meds' },
    });
  });

  it('broadcasts reminder:failed events', () => {
    const getMock = vi.fn().mockReturnValue({ maxId: 0 });
    const allMock = vi.fn().mockReturnValue([]);
    mockPrepare.mockReturnValue({ get: getMock, all: allMock });

    dbPoller.start();

    allMock
      .mockReturnValueOnce([]) // messages
      .mockReturnValueOnce([]) // sent
      .mockReturnValueOnce([{ rowid: 1, id: 7, retryCount: 3, failureReason: 'timeout' }]); // failed

    vi.advanceTimersByTime(2500);

    expect(mockWsHub.broadcast).toHaveBeenCalledWith({
      type: 'reminder:failed',
      data: { id: 7, retryCount: 3, error: 'timeout' },
    });
  });

  it('stop clears the interval', () => {
    const getMock = vi.fn().mockReturnValue({ maxId: 0 });
    mockPrepare.mockReturnValue({ get: getMock, all: vi.fn().mockReturnValue([]) });

    dbPoller.start();
    dbPoller.stop();

    vi.advanceTimersByTime(5000);

    // broadcast should not be called after start's init poll
    // Only the init calls from start(), no poll calls
    expect(mockWsHub.broadcast).not.toHaveBeenCalled();
  });

  it('handles DB errors gracefully during init', () => {
    mockPrepare.mockImplementation(() => {
      throw new Error('DB not ready');
    });

    // Should not throw
    expect(() => dbPoller.start()).not.toThrow();
  });

  it('handles DB errors gracefully during poll', () => {
    const getMock = vi.fn().mockReturnValue({ maxId: 0 });
    mockPrepare.mockReturnValue({ get: getMock, all: vi.fn().mockReturnValue([]) });

    dbPoller.start();

    // Make poll throw
    mockPrepare.mockImplementation(() => {
      throw new Error('DB locked');
    });

    // Should not throw
    expect(() => vi.advanceTimersByTime(2500)).not.toThrow();
  });

  it('truncates long message content to 100 chars for preview', () => {
    const getMock = vi.fn().mockReturnValue({ maxId: 0 });
    const allMock = vi.fn().mockReturnValue([]);
    mockPrepare.mockReturnValue({ get: getMock, all: allMock });

    dbPoller.start();

    const longContent = 'a'.repeat(200);
    allMock.mockReturnValueOnce([
      { rowid: 1, groupId: 'g1', sender: '+123', content: longContent, timestamp: 1000, isBot: 0 },
    ]).mockReturnValue([]);

    vi.advanceTimersByTime(2500);

    const call = mockWsHub.broadcast.mock.calls.find(
      (c: any) => c[0].type === 'message:new',
    );
    expect(call).toBeDefined();
    expect(call![0].data.preview).toHaveLength(100);
  });
});
