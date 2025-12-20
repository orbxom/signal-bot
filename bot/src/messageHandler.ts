import type { Message, ChatMessage } from './types';
import type { Storage } from './storage';
import type { AzureOpenAIClient } from './azureOpenAI';
import type { SignalClient } from './signalClient';

export class MessageHandler {
  private mentionTriggers: string[];
  private storage?: Storage;
  private llmClient?: AzureOpenAIClient;
  private signalClient?: SignalClient;
  private contextWindowSize: number;

  constructor(
    mentionTriggers: string[],
    storage?: Storage,
    llmClient?: AzureOpenAIClient,
    signalClient?: SignalClient,
    contextWindowSize: number = 20
  ) {
    this.mentionTriggers = mentionTriggers;
    this.storage = storage;
    this.llmClient = llmClient;
    this.signalClient = signalClient;
    this.contextWindowSize = contextWindowSize;
  }

  isMentioned(content: string): boolean {
    const lowerContent = content.toLowerCase();
    return this.mentionTriggers.some(trigger =>
      lowerContent.includes(trigger.toLowerCase())
    );
  }

  extractQuery(content: string): string {
    let query = content;
    for (const trigger of this.mentionTriggers) {
      query = query.replace(new RegExp(trigger, 'gi'), '');
    }
    // Replace multiple spaces with a single space and trim
    return query.replace(/\s+/g, ' ').trim();
  }

  buildContext(history: Message[], currentQuery: string): ChatMessage[] {
    const systemPrompt: ChatMessage = {
      role: 'system',
      content: 'You are a helpful family assistant in a Signal group chat. Be friendly, concise, and helpful.'
    };

    const contextMessages: ChatMessage[] = [systemPrompt];

    for (const msg of history) {
      if (msg.isBot) {
        contextMessages.push({
          role: 'assistant',
          content: msg.content
        });
      } else {
        contextMessages.push({
          role: 'user',
          content: `${msg.sender}: ${msg.content}`
        });
      }
    }

    contextMessages.push({
      role: 'user',
      content: currentQuery
    });

    return contextMessages;
  }

  async handleMessage(
    groupId: string,
    sender: string,
    content: string,
    timestamp: number
  ): Promise<void> {
    if (!this.storage || !this.llmClient || !this.signalClient) {
      throw new Error('Handler not fully initialized');
    }

    // Store incoming message
    this.storage.addMessage({
      groupId,
      sender,
      content,
      timestamp,
      isBot: false
    });

    // Check for mention
    if (!this.isMentioned(content)) {
      return;
    }

    try {
      // Extract query
      const query = this.extractQuery(content);

      // Get conversation history
      const history = this.storage.getRecentMessages(groupId, this.contextWindowSize - 1);

      // Build context
      const messages = this.buildContext(history, query);

      // Get LLM response
      const response = await this.llmClient.generateResponse(messages);

      // Send response
      await this.signalClient.sendMessage(groupId, response.content);

      // Store bot response
      this.storage.addMessage({
        groupId,
        sender: 'bot',
        content: response.content,
        timestamp: Date.now(),
        isBot: true
      });

      // Trim old messages
      this.storage.trimMessages(groupId, this.contextWindowSize);

      console.log(`[${groupId}] Responded to ${sender} (${response.tokensUsed} tokens)`);
    } catch (error) {
      console.error('Error handling message:', error);

      // Send error message to group
      const errorMsg = 'Sorry, I encountered an error processing your request.';
      await this.signalClient.sendMessage(groupId, errorMsg);
    }
  }
}
