import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignalClient } from '../src/signalClient';
import type { SignalMessage } from '../src/types';

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

describe('SignalClient', () => {
  describe('Constructor', () => {
    it('should create client with valid parameters', () => {
      const client = new SignalClient('http://localhost:8080', '+1234567890');
      expect(client).toBeInstanceOf(SignalClient);
    });

    it('should accept different URL formats', () => {
      const client1 = new SignalClient('http://localhost:8080', '+1234567890');
      const client2 = new SignalClient('https://signal.example.com', '+1234567890');
      const client3 = new SignalClient('http://192.168.1.100:8080', '+1234567890');

      expect(client1).toBeInstanceOf(SignalClient);
      expect(client2).toBeInstanceOf(SignalClient);
      expect(client3).toBeInstanceOf(SignalClient);
    });

    it('should throw error when base URL is empty', () => {
      expect(() => new SignalClient('', '+1234567890')).toThrow('Base URL is required');
    });

    it('should throw error when account is empty', () => {
      expect(() => new SignalClient('http://localhost:8080', '')).toThrow('Account is required');
    });

    it('should throw error when base URL is invalid', () => {
      expect(() => new SignalClient('not-a-valid-url', '+1234567890')).toThrow('Invalid base URL format');
    });
  });

  describe('extractMessageData', () => {
    it('should extract message data from Signal envelope', () => {
      const client = new SignalClient('http://localhost:8080', '+1234567890');

      const signalMsg: SignalMessage = {
        envelope: {
          sourceNumber: '+9876543210',
          timestamp: 1234567890,
          dataMessage: {
            timestamp: 1234567890,
            message: 'Test message',
            groupInfo: {
              groupId: 'abc123',
            },
          },
        },
      };

      const extracted = client.extractMessageData(signalMsg);
      expect(extracted).not.toBeNull();
      expect(extracted?.sender).toBe('+9876543210');
      expect(extracted?.content).toBe('Test message');
      expect(extracted?.groupId).toBe('abc123');
      expect(extracted?.timestamp).toBe(1234567890);
      expect(extracted?.attachments).toEqual([]);
    });

    it('should use source when sourceNumber is not available', () => {
      const client = new SignalClient('http://localhost:8080', '+1234567890');

      const signalMsg: SignalMessage = {
        envelope: {
          source: '+1111111111',
          timestamp: 1234567890,
          dataMessage: {
            timestamp: 1234567890,
            message: 'Test message',
            groupInfo: {
              groupId: 'abc123',
            },
          },
        },
      };

      const extracted = client.extractMessageData(signalMsg);
      expect(extracted).not.toBeNull();
      expect(extracted?.sender).toBe('+1111111111');
      expect(extracted?.attachments).toEqual([]);
    });

    it('should use "unknown" when no sender info is available', () => {
      const client = new SignalClient('http://localhost:8080', '+1234567890');

      const signalMsg: SignalMessage = {
        envelope: {
          timestamp: 1234567890,
          dataMessage: {
            timestamp: 1234567890,
            message: 'Test message',
            groupInfo: {
              groupId: 'abc123',
            },
          },
        },
      };

      const extracted = client.extractMessageData(signalMsg);
      expect(extracted).not.toBeNull();
      expect(extracted?.sender).toBe('unknown');
      expect(extracted?.attachments).toEqual([]);
    });

    it('should return null when dataMessage is missing', () => {
      const client = new SignalClient('http://localhost:8080', '+1234567890');

      const signalMsg: SignalMessage = {
        envelope: {
          sourceNumber: '+9876543210',
          timestamp: 1234567890,
        },
      };

      const extracted = client.extractMessageData(signalMsg);
      expect(extracted).toBeNull();
    });

    it('should return null when message is missing', () => {
      const client = new SignalClient('http://localhost:8080', '+1234567890');

      const signalMsg: SignalMessage = {
        envelope: {
          sourceNumber: '+9876543210',
          timestamp: 1234567890,
          dataMessage: {
            timestamp: 1234567890,
            groupInfo: {
              groupId: 'abc123',
            },
          },
        },
      };

      const extracted = client.extractMessageData(signalMsg);
      expect(extracted).toBeNull();
    });

    it('should return null when groupInfo is missing', () => {
      const client = new SignalClient('http://localhost:8080', '+1234567890');

      const signalMsg: SignalMessage = {
        envelope: {
          sourceNumber: '+9876543210',
          timestamp: 1234567890,
          dataMessage: {
            timestamp: 1234567890,
            message: 'Test message',
          },
        },
      };

      const extracted = client.extractMessageData(signalMsg);
      expect(extracted).toBeNull();
    });

    it('should return null when message is empty string', () => {
      const client = new SignalClient('http://localhost:8080', '+1234567890');

      const signalMsg: SignalMessage = {
        envelope: {
          sourceNumber: '+9876543210',
          timestamp: 1234567890,
          dataMessage: {
            timestamp: 1234567890,
            message: '',
            groupInfo: {
              groupId: 'abc123',
            },
          },
        },
      };

      const extracted = client.extractMessageData(signalMsg);
      expect(extracted).toBeNull();
    });

    it('should extract attachment metadata from Signal envelope', () => {
      const client = new SignalClient('http://localhost:8080', '+1234567890');

      const signalMsg: SignalMessage = {
        envelope: {
          sourceNumber: '+9876543210',
          timestamp: 1234567890,
          dataMessage: {
            timestamp: 1234567890,
            message: 'claude: check this',
            groupInfo: { groupId: 'abc123' },
            attachments: [
              {
                id: 'attachment-abc',
                contentType: 'audio/aac',
                size: 12345,
                filename: null,
              },
            ],
          },
        },
      };

      const extracted = client.extractMessageData(signalMsg);
      expect(extracted).not.toBeNull();
      expect(extracted?.attachments).toHaveLength(1);
      expect(extracted?.attachments?.[0].id).toBe('attachment-abc');
      expect(extracted?.attachments?.[0].contentType).toBe('audio/aac');
    });

    it('should return message data with empty attachments array when none present', () => {
      const client = new SignalClient('http://localhost:8080', '+1234567890');

      const signalMsg: SignalMessage = {
        envelope: {
          sourceNumber: '+9876543210',
          timestamp: 1234567890,
          dataMessage: {
            timestamp: 1234567890,
            message: 'Hello',
            groupInfo: { groupId: 'abc123' },
          },
        },
      };

      const extracted = client.extractMessageData(signalMsg);
      expect(extracted).not.toBeNull();
      expect(extracted?.attachments).toEqual([]);
    });

    it('should extract data from voice-only messages with no text', () => {
      const client = new SignalClient('http://localhost:8080', '+1234567890');

      const signalMsg: SignalMessage = {
        envelope: {
          sourceNumber: '+9876543210',
          timestamp: 1234567890,
          dataMessage: {
            timestamp: 1234567890,
            groupInfo: { groupId: 'abc123' },
            attachments: [
              {
                id: 'voice-123',
                contentType: 'audio/aac',
                size: 5000,
                filename: null,
              },
            ],
          },
        },
      };

      const extracted = client.extractMessageData(signalMsg);
      expect(extracted).not.toBeNull();
      expect(extracted?.content).toBe('');
      expect(extracted?.attachments).toHaveLength(1);
    });
  });

  describe('receiveMessages', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      fetchMock = vi.fn();
      global.fetch = fetchMock;
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should return parsed messages on success', async () => {
      const client = new SignalClient('http://localhost:8080', '+1234567890');
      const mockMessages: SignalMessage[] = [
        {
          envelope: {
            sourceNumber: '+9876543210',
            timestamp: 1234567890,
            dataMessage: {
              timestamp: 1234567890,
              message: 'Hello',
              groupInfo: { groupId: 'abc123' },
            },
          },
        },
      ];

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ jsonrpc: '2.0', result: mockMessages, id: 1 }),
      });

      const result = await client.receiveMessages();
      expect(result).toEqual(mockMessages);
    });

    it('should return empty array when result is null', async () => {
      const client = new SignalClient('http://localhost:8080', '+1234567890');

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ jsonrpc: '2.0', result: null, id: 1 }),
      });

      const result = await client.receiveMessages();
      expect(result).toEqual([]);
    });

    it('should throw on network error', async () => {
      const client = new SignalClient('http://localhost:8080', '+1234567890');

      fetchMock.mockRejectedValueOnce(new Error('Network error'));

      await expect(client.receiveMessages()).rejects.toThrow('Network error');
    });

    it('should throw on non-ok HTTP response', async () => {
      const client = new SignalClient('http://localhost:8080', '+1234567890');

      fetchMock.mockResolvedValueOnce({
        ok: false,
        statusText: 'Internal Server Error',
      });

      await expect(client.receiveMessages()).rejects.toThrow('Signal API error: Internal Server Error');
    });

    it('should throw on RPC error in response', async () => {
      const client = new SignalClient('http://localhost:8080', '+1234567890');

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          error: { code: -1, message: 'Account not found' },
          id: 1,
        }),
      });

      await expect(client.receiveMessages()).rejects.toThrow('Signal RPC error: Account not found');
    });

    it('should send correct JSON-RPC payload', async () => {
      const client = new SignalClient('http://localhost:8080', '+1234567890');

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ jsonrpc: '2.0', result: [], id: 1 }),
      });

      await client.receiveMessages();

      const callArgs = fetchMock.mock.calls[0][1];
      const body = JSON.parse(callArgs.body);
      expect(body.jsonrpc).toBe('2.0');
      expect(body.method).toBe('receive');
      expect(body.params.account).toBe('+1234567890');
    });
  });

  describe('sendMessage', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      fetchMock = vi.fn();
      global.fetch = fetchMock;
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should throw error when group ID is empty', async () => {
      const client = new SignalClient('http://localhost:8080', '+1234567890');

      await expect(client.sendMessage('', 'Hello')).rejects.toThrow('Group ID is required');
    });

    it('should throw error when message is null', async () => {
      const client = new SignalClient('http://localhost:8080', '+1234567890');

      await expect(client.sendMessage('group123', null as any)).rejects.toThrow('Message is required');
    });

    it('should throw error when message is undefined', async () => {
      const client = new SignalClient('http://localhost:8080', '+1234567890');

      await expect(client.sendMessage('group123', undefined as any)).rejects.toThrow('Message is required');
    });

    it('should send message successfully', async () => {
      const client = new SignalClient('http://localhost:8080', '+1234567890');

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ jsonrpc: '2.0', result: {}, id: 1 }),
      });

      await expect(client.sendMessage('group123', 'Hello')).resolves.toBeUndefined();

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:8080/api/v1/rpc',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
        }),
      );

      const callArgs = fetchMock.mock.calls[0][1];
      const body = JSON.parse(callArgs.body);
      expect(body.jsonrpc).toBe('2.0');
      expect(body.method).toBe('send');
      expect(body.params.account).toBe('+1234567890');
      expect(body.params.groupId).toBe('group123');
      expect(body.params.message).toBe('Hello');
    });

    it('should throw error when response is not ok', async () => {
      const client = new SignalClient('http://localhost:8080', '+1234567890');

      fetchMock.mockResolvedValueOnce({
        ok: false,
        statusText: 'Internal Server Error',
      });

      await expect(client.sendMessage('group123', 'Hello')).rejects.toThrow('Signal API error: Internal Server Error');
    });

    it('should throw error when RPC returns error', async () => {
      const client = new SignalClient('http://localhost:8080', '+1234567890');

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          error: {
            code: -1,
            message: 'Invalid group ID',
          },
          id: 1,
        }),
      });

      await expect(client.sendMessage('group123', 'Hello')).rejects.toThrow('Signal RPC error: Invalid group ID');
    });

    it('should handle network errors', async () => {
      const client = new SignalClient('http://localhost:8080', '+1234567890');

      fetchMock.mockRejectedValueOnce(new Error('Network error'));

      await expect(client.sendMessage('group123', 'Hello')).rejects.toThrow('Network error');
    });

    it('should handle JSON parse errors', async () => {
      const client = new SignalClient('http://localhost:8080', '+1234567890');

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => {
          throw new Error('Invalid JSON');
        },
      });

      await expect(client.sendMessage('group123', 'Hello')).rejects.toThrow('Invalid JSON');
    });
  });

  describe('sendTyping', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      fetchMock = vi.fn();
      global.fetch = fetchMock;
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should send correct JSON-RPC payload for typing indicator', async () => {
      const client = new SignalClient('http://localhost:8080', '+1234567890');

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ jsonrpc: '2.0', result: {}, id: 1 }),
      });

      await client.sendTyping('group123');

      const callArgs = fetchMock.mock.calls[0][1];
      const body = JSON.parse(callArgs.body);
      expect(body.method).toBe('sendTyping');
      expect(body.params.account).toBe('+1234567890');
      expect(body.params.groupId).toBe('group123');
      expect(body.params.stop).toBeUndefined();
    });

    it('should throw on network error', async () => {
      const client = new SignalClient('http://localhost:8080', '+1234567890');

      fetchMock.mockRejectedValueOnce(new Error('Network error'));

      await expect(client.sendTyping('group123')).rejects.toThrow('Network error');
    });

    it('should throw on RPC error', async () => {
      const client = new SignalClient('http://localhost:8080', '+1234567890');

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          error: { code: -1, message: 'Invalid group' },
          id: 1,
        }),
      });

      await expect(client.sendTyping('group123')).rejects.toThrow('Signal RPC error: Invalid group');
    });
  });

  describe('stopTyping', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      fetchMock = vi.fn();
      global.fetch = fetchMock;
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should send correct JSON-RPC payload with stop: true', async () => {
      const client = new SignalClient('http://localhost:8080', '+1234567890');

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ jsonrpc: '2.0', result: {}, id: 1 }),
      });

      await client.stopTyping('group123');

      const callArgs = fetchMock.mock.calls[0][1];
      const body = JSON.parse(callArgs.body);
      expect(body.method).toBe('sendTyping');
      expect(body.params.account).toBe('+1234567890');
      expect(body.params.groupId).toBe('group123');
      expect(body.params.stop).toBe(true);
    });
  });

  describe('waitForReady', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      fetchMock = vi.fn();
      global.fetch = fetchMock;
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should succeed on first attempt', async () => {
      const { logger } = await import('../src/logger');
      const client = new SignalClient('http://localhost:8080', '+1234567890');

      fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ result: [] }) });

      await client.waitForReady(3, 1);

      expect(logger.success).toHaveBeenCalledWith(expect.stringContaining('attempt 1'));
    });

    it('should succeed after retries', async () => {
      const { logger } = await import('../src/logger');
      const client = new SignalClient('http://localhost:8080', '+1234567890');

      fetchMock
        .mockRejectedValueOnce(new Error('Connection refused'))
        .mockResolvedValueOnce({ ok: true, json: async () => ({ result: [] }) });

      await client.waitForReady(3, 1);

      expect(logger.success).toHaveBeenCalledWith(expect.stringContaining('attempt 2'));
    });

    it('should throw after max retries exhausted', async () => {
      const client = new SignalClient('http://localhost:8080', '+1234567890');

      fetchMock.mockRejectedValue(new Error('Connection refused'));

      await expect(client.waitForReady(2, 1)).rejects.toThrow(
        'signal-cli not reachable at http://localhost:8080 after 2 attempts',
      );
    });
  });
});
