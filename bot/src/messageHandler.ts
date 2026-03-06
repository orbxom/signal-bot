import { ContextBuilder } from './contextBuilder';
import { logger } from './logger';
import { estimateTokens } from './mcp/result';
import { MentionDetector } from './mentionDetector';
import { MessageDeduplicator } from './messageDeduplicator';
import type { SignalClient } from './signalClient';
import type { Storage } from './storage';
import type { AppConfig, LLMClient, Message, SignalAttachment } from './types';
import { TypingIndicatorManager } from './typingIndicator';

export interface MessageHandlerOptions {
  systemPrompt?: string;
  contextWindowSize?: number;
  contextTokenBudget?: number;
  messageRetentionCount?: number;
}

export class MessageHandler {
  private mentionDetector: MentionDetector;
  private contextBuilder: ContextBuilder;
  private deduplicator: MessageDeduplicator;
  private typingManager: TypingIndicatorManager;
  private appConfig: AppConfig;
  private storage: Storage;
  private llmClient: LLMClient;
  private signalClient: SignalClient;
  private contextWindowSize: number;
  private messageRetentionCount: number;

  constructor(
    mentionTriggers: string[],
    deps: {
      storage: Storage;
      llmClient: LLMClient;
      signalClient: SignalClient;
      appConfig?: AppConfig;
    },
    options?: MessageHandlerOptions,
  ) {
    this.appConfig = deps.appConfig || {
      dbPath: './data/bot.db',
      timezone: 'Australia/Sydney',
      githubRepo: '',
      sourceRoot: '',
      signalCliUrl: '',
      botPhoneNumber: '',
      attachmentsDir: './data/signal-attachments',
      whisperModelPath: './models/ggml-base.en.bin',
    };
    this.storage = deps.storage;
    this.llmClient = deps.llmClient;
    this.signalClient = deps.signalClient;
    this.contextWindowSize = options?.contextWindowSize || 200;
    this.messageRetentionCount = options?.messageRetentionCount || 1000;

    this.mentionDetector = new MentionDetector(mentionTriggers);
    this.contextBuilder = new ContextBuilder({
      systemPrompt: options?.systemPrompt || '',
      timezone: this.appConfig.timezone,
      contextTokenBudget: options?.contextTokenBudget || 4000,
      attachmentsDir: this.appConfig.attachmentsDir,
    });
    this.deduplicator = new MessageDeduplicator();
    this.typingManager = new TypingIndicatorManager(deps.signalClient);
  }

  async handleMessage(
    groupId: string,
    sender: string,
    content: string,
    timestamp: number,
    attachments: SignalAttachment[] = [],
    options?: { storeOnly?: boolean },
  ): Promise<void> {
    // Skip messages from the bot itself
    if (this.appConfig.botPhoneNumber && sender === this.appConfig.botPhoneNumber) {
      logger.compact('SKIP', `(bot-self) [${groupId}]`);
      return;
    }

    // Skip duplicate messages
    if (this.deduplicator.isDuplicate(groupId, sender, timestamp)) {
      logger.compact('SKIP', `(dedup) [${groupId}] ${sender}`);
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

    logger.group('MESSAGE RECEIVED');
    logger.step(`group: ${groupId}  sender: ${sender}`);
    logger.step(`content: "${content.substring(0, 100)}"`);
    logger.step(`history: ${history.length} messages fetched`);

    await this.typingManager.withTyping(groupId, () =>
      this.processLlmRequest(groupId, sender, content, attachments, history, historyFormatted),
    );
  }

  /** Assemble additional context (dossiers, memories, skills, persona) for the LLM request. */
  private assembleAdditionalContext(groupId: string): {
    additionalContext: string | undefined;
    nameMap: Map<string, string>;
    personaPrompt: string | undefined;
  } {
    const contextParts: string[] = [];
    const dossiers = this.storage.getDossiersByGroup(groupId);
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
    const memories = this.storage.getMemoriesByGroup(groupId);
    if (memories.length > 0) {
      let tokenTotal = 0;
      const memoryLines: string[] = [];
      for (const m of memories) {
        const line = `- **${m.topic}**: ${m.content}`;
        const tokens = estimateTokens(line);
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
    const activePersona = this.storage.getActivePersonaForGroup(groupId);
    const personaPrompt = activePersona?.description;

    return {
      additionalContext: contextParts.join('\n\n') || undefined,
      nameMap,
      personaPrompt,
    };
  }

  private async processLlmRequest(
    groupId: string,
    sender: string,
    content: string,
    attachments: SignalAttachment[],
    history: Message[],
    historyFormatted?: string[],
  ): Promise<void> {
    try {
      // Extract query
      const query = this.mentionDetector.extractQuery(content);
      logger.step(`query: "${query.substring(0, 80)}"`);

      // Append voice and image attachment info to query
      const voiceLines = attachments
        .filter(a => a.contentType.startsWith('audio/'))
        .map(a => this.contextBuilder.formatVoiceAttachment(a.id));
      const imageLines = attachments
        .filter(a => a.contentType.startsWith('image/'))
        .map(a => this.contextBuilder.formatImageAttachment(a.id));
      const allAttachmentLines = [...voiceLines, ...imageLines];
      if (voiceLines.length > 0 || imageLines.length > 0) {
        logger.step(`attachments: ${voiceLines.length} voice, ${imageLines.length} image`);
      }
      let queryWithAttachments = query;
      if (allAttachmentLines.length > 0) {
        const attachmentBlock = allAttachmentLines.join('\n');
        queryWithAttachments = query ? `${query}\n\n${attachmentBlock}` : attachmentBlock;
      }

      // Build additional system context (dossiers + memories + skills + persona)
      const { additionalContext, nameMap, personaPrompt } = this.assembleAdditionalContext(groupId);

      // Build context
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

      logger.step(`context: ${nameMap.size} dossiers${personaPrompt ? ', with persona' : ''}`);

      // Get LLM response
      const startTime = Date.now();
      const response = await this.llmClient.generateResponse(messages, {
        ...this.appConfig,
        groupId,
        sender,
      });

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      logger.step(`llm: response in ${elapsed}s (${response.tokensUsed} tokens)`);

      const botSender = this.appConfig.botPhoneNumber || 'bot';
      if (response.sentViaMcp) {
        // Claude sent messages directly — store each one
        for (const mcpMsg of response.mcpMessages) {
          this.storage.addMessage({
            groupId,
            sender: botSender,
            content: mcpMsg,
            timestamp: Date.now(),
            isBot: true,
          });
        }
        logger.step(`delivery: sent via MCP (${response.mcpMessages.length} message(s))`);
      } else {
        // Fallback: Claude didn't use the MCP tool, send result as before
        await this.signalClient.sendMessage(groupId, response.content);
        this.storage.addMessage({
          groupId,
          sender: botSender,
          content: response.content,
          timestamp: Date.now(),
          isBot: true,
        });
        logger.step('delivery: sent via fallback');
      }

      // Trim old messages
      this.storage.trimMessages(groupId, this.messageRetentionCount);

      logger.groupEnd();
    } catch (error) {
      logger.error('Error handling message:', error);
      logger.groupEnd();

      // Try to send error message to group
      try {
        const errorMsg = 'Sorry, I encountered an error processing your request.';
        await this.signalClient.sendMessage(groupId, errorMsg);
      } catch (sendError) {
        logger.error('Failed to send error message:', sendError);
      }
    }
  }
}
