import type { ClaudeCLIClient } from './claudeClient';
import type { SignalClient } from './signalClient';
import type { Storage } from './storage';
import type { ChatMessage, Message } from './types';

export class MessageHandler {
  private mentionTriggers: string[];
  private lowerTriggers: string[];
  private botPhoneNumber: string;
  private systemPrompt: string;
  private storage?: Storage;
  private llmClient?: ClaudeCLIClient;
  private signalClient?: SignalClient;
  private contextWindowSize: number;
  private timezone: string;
  private dbPath: string;
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
      timezone?: string;
      dbPath?: string;
    },
  ) {
    this.mentionTriggers = mentionTriggers;
    this.lowerTriggers = mentionTriggers.map(t => t.toLowerCase());
    this.botPhoneNumber = options?.botPhoneNumber || '';
    this.systemPrompt = options?.systemPrompt || '';
    this.storage = options?.storage;
    this.llmClient = options?.llmClient;
    this.signalClient = options?.signalClient;
    this.contextWindowSize = options?.contextWindowSize || 20;
    this.timezone = options?.timezone || 'Australia/Sydney';
    this.dbPath = options?.dbPath || './data/bot.db';
  }

  isMentioned(content: string): boolean {
    const lowerContent = content.toLowerCase();
    return this.lowerTriggers.some(trigger => lowerContent.startsWith(trigger));
  }

  extractQuery(content: string): string {
    let query = content;
    for (let i = 0; i < this.mentionTriggers.length; i++) {
      const trigger = this.mentionTriggers[i];
      // Case-insensitive removal without regex to avoid injection
      const lowerTrigger = this.lowerTriggers[i];
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

  buildContext(history: Message[], currentQuery: string, groupId?: string, sender?: string): ChatMessage[] {
    let systemContent = this.systemPrompt;

    if (groupId && sender) {
      const now = new Date();
      // Build a proper ISO 8601 string with timezone offset
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: this.timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        timeZoneName: 'shortOffset',
      }).formatToParts(now);
      const get = (type: string) => parts.find(p => p.type === type)?.value || '';
      const offset = get('timeZoneName').replace('GMT', '') || '+00:00';
      const isoString = `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}${offset}`;
      const unixMs = now.getTime();

      const timeContext = [
        `Current time: ${isoString} (Unix ms: ${unixMs})`,
        `Timezone: ${this.timezone}`,
        `Group ID: ${groupId}`,
        `Current requester: ${sender}`,
      ].join('\n');

      systemContent = `${timeContext}\n\n${systemContent}`;
    }

    const contextMessages: ChatMessage[] = [{ role: 'system', content: systemContent }];

    for (const msg of history) {
      if (msg.isBot) {
        contextMessages.push({
          role: 'assistant',
          content: msg.content,
        });
      } else {
        contextMessages.push({
          role: 'user',
          content: `${msg.sender}: ${msg.content}`,
        });
      }
    }

    contextMessages.push({
      role: 'user',
      content: currentQuery,
    });

    return contextMessages;
  }

  async handleMessage(groupId: string, sender: string, content: string, timestamp: number): Promise<void> {
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

    // Check for mention before storing so history fetch doesn't include current message
    const mentioned = this.isMentioned(content);

    // Get conversation history before storing current message (avoids duplication in context)
    let history: Message[] = [];
    if (mentioned) {
      history = this.storage.getRecentMessages(groupId, this.contextWindowSize - 1);
    }

    // Store incoming message
    this.storage.addMessage({
      groupId,
      sender,
      content,
      timestamp,
      isBot: false,
    });

    if (!mentioned) {
      return;
    }

    try {
      // Extract query
      const query = this.extractQuery(content);

      // Build context
      const messages = this.buildContext(history, query, groupId, sender);

      // Get LLM response
      const response = await this.llmClient.generateResponse(messages, {
        groupId,
        sender,
        dbPath: this.dbPath,
        timezone: this.timezone,
      });

      // Send response
      await this.signalClient.sendMessage(groupId, response.content);

      // Store bot response
      this.storage.addMessage({
        groupId,
        sender: this.botPhoneNumber || 'bot',
        content: response.content,
        timestamp: Date.now(),
        isBot: true,
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
