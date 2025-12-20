import { describe, it, expect, vi } from 'vitest';
import { AzureOpenAIClient } from '../src/azureOpenAI';
import type { ChatMessage } from '../src/types';

describe('AzureOpenAIClient', () => {
  it('should format conversation history correctly', () => {
    const client = new AzureOpenAIClient(
      'https://test.openai.azure.com/',
      'test-key',
      'gpt-4o'
    );

    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
      { role: 'user', content: 'How are you?' }
    ];

    const formatted = client.formatMessages(messages);
    expect(formatted).toHaveLength(4);
    expect(formatted[0].role).toBe('system');
    expect(formatted[3].role).toBe('user');
  });
});
