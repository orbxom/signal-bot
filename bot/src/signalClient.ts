import type { SignalMessage, SignalSendRequest } from './types';

export class SignalClient {
  private baseUrl: string;
  private account: string;

  constructor(baseUrl: string, account: string) {
    if (!baseUrl) {
      throw new Error('Base URL is required');
    }
    if (!account) {
      throw new Error('Account is required');
    }

    // Basic URL validation
    try {
      new URL(baseUrl);
    } catch {
      throw new Error('Invalid base URL format');
    }

    this.baseUrl = baseUrl;
    this.account = account;
  }

  buildSendRequest(groupId: string, message: string): SignalSendRequest {
    return {
      groupId,
      message
    };
  }

  async sendMessage(groupId: string, message: string): Promise<void> {
    if (!groupId) {
      throw new Error('Group ID is required');
    }
    if (message === undefined || message === null) {
      throw new Error('Message is required');
    }

    const payload = {
      jsonrpc: '2.0',
      method: 'send',
      params: {
        account: this.account,
        groupId,
        message
      },
      id: Date.now()
    };

    try {
      const response = await fetch(`${this.baseUrl}/api/v1/rpc`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error(`Signal API error: ${response.statusText}`);
      }

      const result = await response.json();
      if (result.error) {
        throw new Error(`Signal RPC error: ${result.error.message}`);
      }
    } catch (error) {
      console.error('Failed to send Signal message:', error);
      throw error;
    }
  }

  extractMessageData(signalMsg: SignalMessage): {
    sender: string;
    content: string;
    groupId: string;
    timestamp: number;
  } | null {
    const envelope = signalMsg.envelope;
    const dataMessage = envelope.dataMessage;

    if (!dataMessage?.message || !dataMessage.groupInfo?.groupId) {
      return null;
    }

    return {
      sender: envelope.sourceNumber || envelope.source || 'unknown',
      content: dataMessage.message,
      groupId: dataMessage.groupInfo.groupId,
      timestamp: envelope.timestamp
    };
  }
}
