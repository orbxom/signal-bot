import { AzureOpenAI } from 'openai';
import type { ChatMessage, LLMResponse } from './types';

export class AzureOpenAIClient {
  private client: AzureOpenAI;
  private deployment: string;

  constructor(endpoint: string, key: string, deployment: string) {
    this.client = new AzureOpenAI({
      endpoint,
      apiKey: key,
      apiVersion: '2024-10-21'
    });
    this.deployment = deployment;
  }

  formatMessages(messages: ChatMessage[]): ChatMessage[] {
    return messages;
  }

  async generateResponse(messages: ChatMessage[]): Promise<LLMResponse> {
    try {
      const result = await this.client.chat.completions.create({
        model: this.deployment,
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        temperature: 0.7,
        max_tokens: 500
      });

      const choice = result.choices[0];
      if (!choice?.message?.content) {
        throw new Error('No response from Azure OpenAI');
      }

      return {
        content: choice.message.content,
        tokensUsed: result.usage?.total_tokens || 0
      };
    } catch (error) {
      console.error('Azure OpenAI error:', error);
      throw new Error('Failed to generate response from LLM');
    }
  }
}
