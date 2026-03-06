import { logger } from './logger';

export interface TypingClient {
  sendTyping(groupId: string): Promise<void>;
  stopTyping(groupId: string): Promise<void>;
}

export class TypingIndicatorManager {
  constructor(private client: TypingClient) {}

  async withTyping<T>(groupId: string, fn: () => Promise<T>): Promise<T> {
    try {
      await this.client.sendTyping(groupId);
    } catch (error) {
      logger.error('Failed to start typing indicator:', error);
    }

    const interval = setInterval(() => {
      this.client.sendTyping(groupId).catch(() => {});
    }, 10_000);

    try {
      return await fn();
    } finally {
      clearInterval(interval);
      try {
        await this.client.stopTyping(groupId);
      } catch (error) {
        logger.error('Failed to stop typing indicator:', error);
      }
    }
  }
}
