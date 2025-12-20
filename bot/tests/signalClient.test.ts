import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SignalClient } from '../src/signalClient';
import type { SignalMessage } from '../src/types';

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
      expect(() => new SignalClient('', '+1234567890'))
        .toThrow('Base URL is required');
    });

    it('should throw error when account is empty', () => {
      expect(() => new SignalClient('http://localhost:8080', ''))
        .toThrow('Account is required');
    });

    it('should throw error when base URL is invalid', () => {
      expect(() => new SignalClient('not-a-valid-url', '+1234567890'))
        .toThrow('Invalid base URL format');
    });
  });

  describe('buildSendRequest', () => {
    it('should construct send message request', () => {
      const client = new SignalClient('http://localhost:8080', '+1234567890');

      const request = client.buildSendRequest('group123', 'Hello world');
      expect(request.groupId).toBe('group123');
      expect(request.message).toBe('Hello world');
    });

    it('should handle empty message', () => {
      const client = new SignalClient('http://localhost:8080', '+1234567890');

      const request = client.buildSendRequest('group123', '');
      expect(request.groupId).toBe('group123');
      expect(request.message).toBe('');
    });

    it('should handle special characters in message', () => {
      const client = new SignalClient('http://localhost:8080', '+1234567890');

      const specialMessage = 'Hello! @user #tag $100 & more 🎉';
      const request = client.buildSendRequest('group123', specialMessage);
      expect(request.message).toBe(specialMessage);
    });

    it('should handle multiline messages', () => {
      const client = new SignalClient('http://localhost:8080', '+1234567890');

      const multilineMessage = 'Line 1\nLine 2\nLine 3';
      const request = client.buildSendRequest('group123', multilineMessage);
      expect(request.message).toBe(multilineMessage);
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
              groupId: 'abc123'
            }
          }
        }
      };

      const extracted = client.extractMessageData(signalMsg);
      expect(extracted).not.toBeNull();
      expect(extracted!.sender).toBe('+9876543210');
      expect(extracted!.content).toBe('Test message');
      expect(extracted!.groupId).toBe('abc123');
      expect(extracted!.timestamp).toBe(1234567890);
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
              groupId: 'abc123'
            }
          }
        }
      };

      const extracted = client.extractMessageData(signalMsg);
      expect(extracted).not.toBeNull();
      expect(extracted!.sender).toBe('+1111111111');
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
              groupId: 'abc123'
            }
          }
        }
      };

      const extracted = client.extractMessageData(signalMsg);
      expect(extracted).not.toBeNull();
      expect(extracted!.sender).toBe('unknown');
    });

    it('should return null when dataMessage is missing', () => {
      const client = new SignalClient('http://localhost:8080', '+1234567890');

      const signalMsg: SignalMessage = {
        envelope: {
          sourceNumber: '+9876543210',
          timestamp: 1234567890
        }
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
              groupId: 'abc123'
            }
          }
        }
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
            message: 'Test message'
          }
        }
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
              groupId: 'abc123'
            }
          }
        }
      };

      const extracted = client.extractMessageData(signalMsg);
      expect(extracted).toBeNull();
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

      await expect(client.sendMessage('', 'Hello'))
        .rejects.toThrow('Group ID is required');
    });

    it('should throw error when message is null', async () => {
      const client = new SignalClient('http://localhost:8080', '+1234567890');

      await expect(client.sendMessage('group123', null as any))
        .rejects.toThrow('Message is required');
    });

    it('should throw error when message is undefined', async () => {
      const client = new SignalClient('http://localhost:8080', '+1234567890');

      await expect(client.sendMessage('group123', undefined as any))
        .rejects.toThrow('Message is required');
    });

    it('should send message successfully', async () => {
      const client = new SignalClient('http://localhost:8080', '+1234567890');

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ jsonrpc: '2.0', result: {}, id: 1 })
      });

      await expect(client.sendMessage('group123', 'Hello')).resolves.toBeUndefined();

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:8080/api/v1/rpc',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          }
        })
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
        statusText: 'Internal Server Error'
      });

      await expect(client.sendMessage('group123', 'Hello'))
        .rejects.toThrow('Signal API error: Internal Server Error');
    });

    it('should throw error when RPC returns error', async () => {
      const client = new SignalClient('http://localhost:8080', '+1234567890');

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          error: {
            code: -1,
            message: 'Invalid group ID'
          },
          id: 1
        })
      });

      await expect(client.sendMessage('group123', 'Hello'))
        .rejects.toThrow('Signal RPC error: Invalid group ID');
    });

    it('should handle network errors', async () => {
      const client = new SignalClient('http://localhost:8080', '+1234567890');

      fetchMock.mockRejectedValueOnce(new Error('Network error'));

      await expect(client.sendMessage('group123', 'Hello'))
        .rejects.toThrow('Network error');
    });

    it('should handle JSON parse errors', async () => {
      const client = new SignalClient('http://localhost:8080', '+1234567890');

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => {
          throw new Error('Invalid JSON');
        }
      });

      await expect(client.sendMessage('group123', 'Hello'))
        .rejects.toThrow('Invalid JSON');
    });
  });
});
