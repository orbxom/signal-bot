import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AzureOpenAIClient } from '../src/azureOpenAI';
import type { ChatMessage } from '../src/types';
import { OpenAIClient } from '@azure/openai';

vi.mock('@azure/openai');

describe('AzureOpenAIClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Constructor validation', () => {
    it('should throw error when endpoint is empty', () => {
      expect(() => new AzureOpenAIClient('', 'test-key', 'gpt-4o')).toThrow(
        'Azure OpenAI endpoint is required and cannot be empty'
      );
    });

    it('should throw error when key is empty', () => {
      expect(() => new AzureOpenAIClient('https://test.openai.azure.com/', '', 'gpt-4o')).toThrow(
        'Azure OpenAI key is required and cannot be empty'
      );
    });

    it('should throw error when deployment is empty', () => {
      expect(() => new AzureOpenAIClient('https://test.openai.azure.com/', 'test-key', '')).toThrow(
        'Azure OpenAI deployment name is required and cannot be empty'
      );
    });

    it('should throw error when endpoint is whitespace only', () => {
      expect(() => new AzureOpenAIClient('   ', 'test-key', 'gpt-4o')).toThrow(
        'Azure OpenAI endpoint is required and cannot be empty'
      );
    });

    it('should create client successfully with valid parameters', () => {
      expect(() => new AzureOpenAIClient('https://test.openai.azure.com/', 'test-key', 'gpt-4o')).not.toThrow();
    });
  });

  describe('formatMessages', () => {
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

  describe('generateResponse', () => {
    it('should throw error when messages array is empty', async () => {
      const client = new AzureOpenAIClient(
        'https://test.openai.azure.com/',
        'test-key',
        'gpt-4o'
      );

      await expect(client.generateResponse([])).rejects.toThrow('Messages array cannot be empty');
    });

    it('should throw error when messages array is null/undefined', async () => {
      const client = new AzureOpenAIClient(
        'https://test.openai.azure.com/',
        'test-key',
        'gpt-4o'
      );

      await expect(client.generateResponse(null as any)).rejects.toThrow('Messages array cannot be empty');
    });

    it('should generate response successfully with valid messages', async () => {
      const mockGetChatCompletions = vi.fn().mockResolvedValue({
        choices: [
          {
            message: {
              content: 'Hello! How can I help you?'
            }
          }
        ],
        usage: {
          totalTokens: 25
        }
      });

      vi.mocked(OpenAIClient).mockImplementation(() => ({
        getChatCompletions: mockGetChatCompletions
      } as any));

      const client = new AzureOpenAIClient(
        'https://test.openai.azure.com/',
        'test-key',
        'gpt-4o'
      );

      const messages: ChatMessage[] = [
        { role: 'user', content: 'Hello' }
      ];

      const response = await client.generateResponse(messages);

      expect(response).toEqual({
        content: 'Hello! How can I help you?',
        tokensUsed: 25
      });
      expect(mockGetChatCompletions).toHaveBeenCalledWith(
        'gpt-4o',
        [{ role: 'user', content: 'Hello' }],
        { temperature: 0.7, maxTokens: 500 }
      );
    });

    it('should throw error when no choices are returned', async () => {
      const mockGetChatCompletions = vi.fn().mockResolvedValue({
        choices: []
      });

      vi.mocked(OpenAIClient).mockImplementation(() => ({
        getChatCompletions: mockGetChatCompletions
      } as any));

      const client = new AzureOpenAIClient(
        'https://test.openai.azure.com/',
        'test-key',
        'gpt-4o'
      );

      const messages: ChatMessage[] = [
        { role: 'user', content: 'Hello' }
      ];

      await expect(client.generateResponse(messages)).rejects.toThrow('No choices returned from Azure OpenAI');
    });

    it('should throw error when choices array is undefined', async () => {
      const mockGetChatCompletions = vi.fn().mockResolvedValue({
        usage: { totalTokens: 0 }
      });

      vi.mocked(OpenAIClient).mockImplementation(() => ({
        getChatCompletions: mockGetChatCompletions
      } as any));

      const client = new AzureOpenAIClient(
        'https://test.openai.azure.com/',
        'test-key',
        'gpt-4o'
      );

      const messages: ChatMessage[] = [
        { role: 'user', content: 'Hello' }
      ];

      await expect(client.generateResponse(messages)).rejects.toThrow('No choices returned from Azure OpenAI');
    });

    it('should handle API errors and preserve error details', async () => {
      const originalError = new Error('API rate limit exceeded');
      const mockGetChatCompletions = vi.fn().mockRejectedValue(originalError);

      vi.mocked(OpenAIClient).mockImplementation(() => ({
        getChatCompletions: mockGetChatCompletions
      } as any));

      const client = new AzureOpenAIClient(
        'https://test.openai.azure.com/',
        'test-key',
        'gpt-4o'
      );

      const messages: ChatMessage[] = [
        { role: 'user', content: 'Hello' }
      ];

      await expect(client.generateResponse(messages)).rejects.toThrow('Failed to generate response from LLM: API rate limit exceeded');
    });

    it('should default to 0 tokens when usage is undefined', async () => {
      const mockGetChatCompletions = vi.fn().mockResolvedValue({
        choices: [
          {
            message: {
              content: 'Response without usage data'
            }
          }
        ]
      });

      vi.mocked(OpenAIClient).mockImplementation(() => ({
        getChatCompletions: mockGetChatCompletions
      } as any));

      const client = new AzureOpenAIClient(
        'https://test.openai.azure.com/',
        'test-key',
        'gpt-4o'
      );

      const messages: ChatMessage[] = [
        { role: 'user', content: 'Hello' }
      ];

      const response = await client.generateResponse(messages);

      expect(response.tokensUsed).toBe(0);
    });
  });
});
