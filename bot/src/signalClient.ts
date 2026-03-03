import type { SignalAttachment, SignalMessage } from './types';

export class SignalClient {
  private baseUrl: string;
  private account: string;
  private requestIdCounter = 0;

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

  private async rpc<T>(method: string, params: Record<string, unknown>, timeoutMs = 30000): Promise<T> {
    const response = await fetch(`${this.baseUrl}/api/v1/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method,
        params: { account: this.account, ...params },
        id: `${Date.now()}-${++this.requestIdCounter}`,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`Signal API error: ${response.statusText}`);
    const result = (await response.json()) as { error?: { message: string }; result?: T };
    if (result.error) throw new Error(`Signal RPC error: ${result.error.message}`);
    return result.result as T;
  }

  async sendMessage(groupId: string, message: string): Promise<void> {
    if (!groupId) {
      throw new Error('Group ID is required');
    }
    if (message === undefined || message === null) {
      throw new Error('Message is required');
    }
    await this.rpc('send', { groupId, message });
  }

  async sendTyping(groupId: string): Promise<void> {
    await this.rpc('sendTyping', { groupId });
  }

  async stopTyping(groupId: string): Promise<void> {
    await this.rpc('sendTyping', { groupId, stop: true });
  }

  async receiveMessages(): Promise<SignalMessage[]> {
    return (await this.rpc<SignalMessage[]>('receive', {})) ?? [];
  }

  async waitForReady(maxRetries: number = 10, baseDelay: number = 2000): Promise<void> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.rpc('listGroups', {}, 5000);
        console.log(`signal-cli is ready (attempt ${attempt})`);
        return;
      } catch {
        // Expected during startup
      }

      if (attempt < maxRetries) {
        const delay = baseDelay * attempt;
        console.log(`Waiting for signal-cli... (attempt ${attempt}/${maxRetries}, retry in ${delay}ms)`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw new Error(`signal-cli not reachable at ${this.baseUrl} after ${maxRetries} attempts`);
  }

  extractMessageData(signalMsg: SignalMessage): {
    sender: string;
    content: string;
    groupId: string;
    timestamp: number;
    attachments: SignalAttachment[];
  } | null {
    const envelope = signalMsg.envelope;
    const dataMessage = envelope.dataMessage;
    const attachments = dataMessage?.attachments ?? [];
    const hasContent = !!dataMessage?.message;
    const hasAttachments = attachments.length > 0;

    if ((!hasContent && !hasAttachments) || !dataMessage?.groupInfo?.groupId) {
      return null;
    }

    return {
      sender: envelope.sourceNumber || envelope.source || 'unknown',
      content: dataMessage.message ?? '',
      groupId: dataMessage.groupInfo.groupId,
      timestamp: envelope.timestamp,
      attachments,
    };
  }
}
