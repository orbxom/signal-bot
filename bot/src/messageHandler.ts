import type { ClaudeCLIClient } from './claudeClient';
import { ContextBuilder } from './contextBuilder';
import { MentionDetector } from './mentionDetector';
import { MessageDeduplicator } from './messageDeduplicator';
import type { SignalClient } from './signalClient';
import type { Storage } from './storage';
import type { Message, MessageContext, SignalAttachment } from './types';
import { TypingIndicatorManager } from './typingIndicator';

export class MessageHandler {
  private mentionDetector: MentionDetector;
  private contextBuilder: ContextBuilder;
  private deduplicator: MessageDeduplicator;
  private typingManager: TypingIndicatorManager;
  private messageContext: MessageContext;
  private storage?: Storage;
  private llmClient?: ClaudeCLIClient;
  private signalClient?: SignalClient;
  private contextWindowSize: number;
  private messageRetentionCount: number;

  constructor(
    mentionTriggers: string[],
    options?: {
      messageContext?: MessageContext;
      systemPrompt?: string;
      storage?: Storage;
      llmClient?: ClaudeCLIClient;
      signalClient?: SignalClient;
      contextWindowSize?: number;
      contextTokenBudget?: number;
      messageRetentionCount?: number;
    },
  ) {
    this.messageContext = options?.messageContext || {
      groupId: '',
      sender: '',
      dbPath: './data/bot.db',
      timezone: 'Australia/Sydney',
      githubRepo: '',
      sourceRoot: '',
      signalCliUrl: '',
      botPhoneNumber: '',
      attachmentsDir: './data/signal-attachments',
      whisperModelPath: './models/ggml-base.en.bin',
    };
    this.storage = options?.storage;
    this.llmClient = options?.llmClient;
    this.signalClient = options?.signalClient;
    this.contextWindowSize = options?.contextWindowSize || 200;
    this.messageRetentionCount = options?.messageRetentionCount || 1000;

    this.mentionDetector = new MentionDetector(mentionTriggers);
    this.contextBuilder = new ContextBuilder({
      systemPrompt: options?.systemPrompt || '',
      timezone: this.messageContext.timezone,
      contextTokenBudget: options?.contextTokenBudget || 4000,
      attachmentsDir: this.messageContext.attachmentsDir,
    });
    this.deduplicator = new MessageDeduplicator();
    // TypingIndicatorManager is only used when signalClient is provided
    this.typingManager = new TypingIndicatorManager(
      options?.signalClient || ({ sendTyping: async () => {}, stopTyping: async () => {} } as SignalClient),
    );
  }

  async handleMessage(
    groupId: string,
    sender: string,
    content: string,
    timestamp: number,
    attachments: SignalAttachment[] = [],
    options?: { storeOnly?: boolean },
  ): Promise<void> {
    if (!this.storage || !this.llmClient || !this.signalClient) {
      throw new Error('Handler not fully initialized');
    }

    // Skip messages from the bot itself
    if (this.messageContext.botPhoneNumber && sender === this.messageContext.botPhoneNumber) {
      return;
    }

    // Skip duplicate messages
    if (this.deduplicator.isDuplicate(groupId, sender, timestamp)) {
      return;
    }

    // Check for mention before storing so history fetch doesn't include current message
    const mentioned = this.mentionDetector.isMentioned(content);

    // Get conversation history before storing current message (avoids duplication in context)
    let history: Message[] = [];
    let historyFormatted: string[] | undefined;
    if (mentioned) {
      const batch = this.storage.getRecentMessages(groupId, this.contextWindowSize);
      const fitted = this.contextBuilder.fitToTokenBudget(batch);
      history = fitted.messages;
      historyFormatted = fitted.formatted;
    }

    // Store incoming message (including any attachments for later context)
    this.storage.addMessage({
      groupId,
      sender,
      content,
      timestamp,
      isBot: false,
      attachments: attachments.length > 0 ? attachments : undefined,
    });

    if (options?.storeOnly || !mentioned) {
      return;
    }

    await this.typingManager.withTyping(groupId, () =>
      this.processLlmRequest(groupId, sender, content, attachments, history, historyFormatted),
    );
  }

  private async processLlmRequest(
    groupId: string,
    sender: string,
    content: string,
    attachments: SignalAttachment[],
    history: Message[],
    historyFormatted?: string[],
  ): Promise<void> {
    // These are guaranteed non-null by the guard in handleMessage
    const storage = this.storage as Storage;
    const llmClient = this.llmClient as ClaudeCLIClient;
    const signalClient = this.signalClient as SignalClient;

    try {
      // Extract query
      const query = this.mentionDetector.extractQuery(content);

      // Append voice and image attachment info to query
      const voiceLines = attachments
        .filter(a => a.contentType.startsWith('audio/'))
        .map(a => this.contextBuilder.formatVoiceAttachment(a.id));
      const imageLines = attachments
        .filter(a => a.contentType.startsWith('image/'))
        .map(a => this.contextBuilder.formatImageAttachment(a.id));
      const allAttachmentLines = [...voiceLines, ...imageLines];
      let queryWithAttachments = query;
      if (allAttachmentLines.length > 0) {
        const attachmentBlock = allAttachmentLines.join('\n');
        queryWithAttachments = query ? `${query}\n\n${attachmentBlock}` : attachmentBlock;
      }

      // Build additional system context (dossiers + skills)
      const contextParts: string[] = [];
      const dossiers = storage.getDossiersByGroup(groupId);
      const nameMap = new Map(dossiers.map(d => [d.personId, d.displayName]));
      if (dossiers.length > 0) {
        const entries = dossiers.map(d => {
          const parts = [`- ${d.displayName} (${d.personId})`];
          if (d.notes) parts.push(`  ${d.notes}`);
          return parts.join('\n');
        });
        contextParts.push(`## People in this group\n${entries.join('\n')}`);
      }
      const MEMORY_CONTEXT_BUDGET = 2000;
      const memories = storage.getMemoriesByGroup(groupId);
      if (memories.length > 0) {
        let tokenTotal = 0;
        const memoryLines: string[] = [];
        for (const m of memories) {
          const line = `- **${m.topic}**: ${m.content}`;
          const tokens = Math.ceil(line.length / 4);
          if (tokenTotal + tokens > MEMORY_CONTEXT_BUDGET) break;
          tokenTotal += tokens;
          memoryLines.push(line);
        }
        if (memoryLines.length > 0) {
          contextParts.push(`## Group Memory\n${memoryLines.join('\n')}`);
        }
      }
      const skillContent = this.contextBuilder.loadSkillContent();
      if (skillContent) {
        contextParts.push(skillContent);
      }

      // Look up active persona for this group
      const activePersona = storage.getActivePersonaForGroup(groupId);
      const personaPrompt = activePersona?.description;

      // Build context
      const additionalContext = contextParts.join('\n\n') || undefined;
      const messages = this.contextBuilder.buildContext({
        history,
        query: queryWithAttachments,
        groupId,
        sender,
        dossierContext: additionalContext,
        personaDescription: personaPrompt,
        nameMap,
        preFormatted: historyFormatted,
      });

      // Get LLM response
      const response = await llmClient.generateResponse(messages, {
        ...this.messageContext,
        groupId,
        sender,
      });

      const botSender = this.messageContext.botPhoneNumber || 'bot';
      if (response.sentViaMcp) {
        // Claude sent messages directly — store each one
        for (const mcpMsg of response.mcpMessages) {
          storage.addMessage({
            groupId,
            sender: botSender,
            content: mcpMsg,
            timestamp: Date.now(),
            isBot: true,
          });
        }
      } else {
        // Fallback: Claude didn't use the MCP tool, send result as before
        await signalClient.sendMessage(groupId, response.content);
        storage.addMessage({
          groupId,
          sender: botSender,
          content: response.content,
          timestamp: Date.now(),
          isBot: true,
        });
      }

      // Trim old messages
      storage.trimMessages(groupId, this.messageRetentionCount);

      console.log(`[${groupId}] Responded to ${sender} (${response.tokensUsed} tokens)`);
    } catch (error) {
      console.error('Error handling message:', error);

      // Try to send error message to group
      try {
        const errorMsg = 'Sorry, I encountered an error processing your request.';
        await signalClient.sendMessage(groupId, errorMsg);
      } catch (sendError) {
        console.error('Failed to send error message:', sendError);
      }
    }
  }
}
