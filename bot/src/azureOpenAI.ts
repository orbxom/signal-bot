import { OpenAIClient, AzureKeyCredential } from '@azure/openai';
import type { ChatMessage, LLMResponse } from './types';

export class AzureOpenAIClient {
  private client: OpenAIClient;
  private deployment: string;

  constructor(endpoint: string, key: string, deployment: string) {
    if (!endpoint || endpoint.trim() === '') {
      throw new Error('Azure OpenAI endpoint is required and cannot be empty');
    }
    if (!key || key.trim() === '') {
      throw new Error('Azure OpenAI key is required and cannot be empty');
    }
    if (!deployment || deployment.trim() === '') {
      throw new Error('Azure OpenAI deployment name is required and cannot be empty');
    }

    this.client = new OpenAIClient(endpoint, new AzureKeyCredential(key));
    this.deployment = deployment;
  }

  formatMessages(messages: ChatMessage[]): ChatMessage[] {
    return messages;
  }

  async generateResponse(messages: ChatMessage[]): Promise<LLMResponse> {
    if (!messages || messages.length === 0) {
      throw new Error('Messages array cannot be empty');
    }

    try {
      const result = await this.client.getChatCompletions(
        this.deployment,
        messages.map(m => ({ role: m.role, content: m.content })),
        {
          temperature: 0.7,
          maxTokens: 500
        }
      );

      if (!result.choices || result.choices.length === 0) {
        throw new Error('No choices returned from Azure OpenAI');
      }

      const choice = result.choices[0];
      if (!choice?.message?.content) {
        throw new Error('No response from Azure OpenAI');
      }

      return {
        content: choice.message.content,
        tokensUsed: result.usage?.totalTokens || 0
      };
    } catch (error) {
      console.error('Azure OpenAI error:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to generate response from LLM: ${errorMessage}`, { cause: error });
    }
  }
}
