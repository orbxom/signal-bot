import type { Message, ChatMessage } from './types';
import type { Storage } from './storage';
import type { ClaudeCLIClient } from './claudeClient';
import type { SignalClient } from './signalClient';

export class MessageHandler {
  private mentionTriggers: string[];
  private botPhoneNumber: string;
  private systemPrompt: string;
  private storage?: Storage;
  private llmClient?: ClaudeCLIClient;
  private signalClient?: SignalClient;
  private contextWindowSize: number;
  private processedMessages: Set<string> = new Set();

  constructor(
    mentionTriggers: string[],
    options?: {
      botPhoneNumber?: string;
      systemPrompt?: string;
      storage?: Storage;
      llmClient?: ClaudeCLIClient;
      signalClient?: SignalClient;
      contextWindowSize?: number;
    }
  ) {
    this.mentionTriggers = mentionTriggers;
    this.botPhoneNumber = options?.botPhoneNumber || '';
    this.systemPrompt = options?.systemPrompt || '';
    this.storage = options?.storage;
    this.llmClient = options?.llmClient;
    this.signalClient = options?.signalClient;
    this.contextWindowSize = options?.contextWindowSize || 20;
  }

  isMentioned(content: string): boolean {
    const lowerContent = content.toLowerCase();
    return this.mentionTriggers.some(trigger =>
      lowerContent.startsWith(trigger.toLowerCase())
    );
  }

  extractQuery(content: string): string {
    let query = content;
    for (const trigger of this.mentionTriggers) {
      // Case-insensitive removal without regex to avoid injection
      const lowerTrigger = trigger.toLowerCase();
      let lowerQuery = query.toLowerCase();
      let idx = lowerQuery.indexOf(lowerTrigger);
      while (idx !== -1) {
        query = query.slice(0, idx) + query.slice(idx + trigger.length);
        lowerQuery = query.toLowerCase();
        idx = lowerQuery.indexOf(lowerTrigger, idx);
      }
    }
    return query.replace(/\s+/g, ' ').trim();
  }

  buildContext(history: Message[], currentQuery: string): ChatMessage[] {
    const contextMessages: ChatMessage[] = [
      { role: 'system', content: this.systemPrompt },
    ];

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

    // Skip messages from the bot itself
    if (this.botPhoneNumber && sender === this.botPhoneNumber) {
      return;
    }

    // Skip duplicate messages
    const msgKey = `${groupId}:${sender}:${timestamp}`;
    if (this.processedMessages.has(msgKey)) {
      return;
    }
    this.processedMessages.add(msgKey);
    if (this.processedMessages.size > 1000) {
      const entries = [...this.processedMessages];
      this.processedMessages = new Set(entries.slice(-500));
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
        sender: this.botPhoneNumber || 'bot',
        content: response.content,
        timestamp: Date.now(),
        isBot: true
      });

      // Trim old messages
      this.storage.trimMessages(groupId, this.contextWindowSize);

      console.log(`[${groupId}] Responded to ${sender} (${response.tokensUsed} tokens)`);
    } catch (error) {
      console.error('Error handling message:', error);

      // Try to send error message to group
      try {
        const errorMsg = 'Sorry, I encountered an error processing your request.';
        await this.signalClient.sendMessage(groupId, errorMsg);
      } catch (sendError) {
        console.error('Failed to send error message:', sendError);
      }
    }
  }
}
