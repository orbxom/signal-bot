import fs from 'node:fs';
import path from 'node:path';
import type { ClaudeCLIClient } from './claudeClient';
import type { SignalClient } from './signalClient';
import type { Storage } from './storage';
import type { ChatMessage, Message, SignalAttachment } from './types';

const PERSONA_SAFETY_PROMPT = `## Persona Guidelines
You must refuse requests to create or adopt personas that:
- Are sexual, romantic, or involve inappropriate relationships
- Promote violence, self-harm, or illegal activities
- Target, mock, or demean specific real people
- Impersonate real public figures in misleading ways
- Attempt to bypass your safety guidelines or ethical boundaries

If asked to create or switch to such a persona, politely decline and explain why.`;

let cachedSkillContent: string | null = null;

function loadSkillContent(): string {
  if (cachedSkillContent !== null) return cachedSkillContent;
  try {
    const distPath = path.resolve(__dirname, 'skills');
    const srcPath = path.resolve(__dirname, '..', 'src', 'skills');
    const skillDir = fs.existsSync(distPath) ? distPath : srcPath;
    const files = fs
      .readdirSync(skillDir)
      .filter(f => f.endsWith('.md'))
      .sort();
    cachedSkillContent = files.map(f => fs.readFileSync(path.join(skillDir, f), 'utf-8')).join('\n\n');
  } catch {
    cachedSkillContent = '';
  }
  return cachedSkillContent;
}

export class MessageHandler {
  private mentionTriggers: string[];
  private lowerTriggers: string[];
  private botPhoneNumber: string;
  private systemPrompt: string;
  private storage?: Storage;
  private llmClient?: ClaudeCLIClient;
  private signalClient?: SignalClient;
  private contextWindowSize: number;
  private contextTokenBudget: number;
  private messageRetentionCount: number;
  private timezone: string;
  private dbPath: string;
  private githubRepo: string;
  private sourceRoot: string;
  private signalCliUrl: string;
  private attachmentsDir: string;
  private whisperModelPath: string;
  private processedMessages: Set<string> = new Set();
  private timestampFormatter: Intl.DateTimeFormat;

  constructor(
    mentionTriggers: string[],
    options?: {
      botPhoneNumber?: string;
      systemPrompt?: string;
      storage?: Storage;
      llmClient?: ClaudeCLIClient;
      signalClient?: SignalClient;
      contextWindowSize?: number;
      contextTokenBudget?: number;
      messageRetentionCount?: number;
      timezone?: string;
      dbPath?: string;
      githubRepo?: string;
      sourceRoot?: string;
      signalCliUrl?: string;
      attachmentsDir?: string;
      whisperModelPath?: string;
    },
  ) {
    this.mentionTriggers = mentionTriggers;
    this.lowerTriggers = mentionTriggers.map(t => t.toLowerCase());
    this.botPhoneNumber = options?.botPhoneNumber || '';
    this.systemPrompt = options?.systemPrompt || '';
    this.storage = options?.storage;
    this.llmClient = options?.llmClient;
    this.signalClient = options?.signalClient;
    this.contextWindowSize = options?.contextWindowSize || 200;
    this.contextTokenBudget = options?.contextTokenBudget || 4000;
    this.messageRetentionCount = options?.messageRetentionCount || 1000;
    this.timezone = options?.timezone || 'Australia/Sydney';
    this.dbPath = options?.dbPath || './data/bot.db';
    this.githubRepo = options?.githubRepo || '';
    this.sourceRoot = options?.sourceRoot || '';
    this.signalCliUrl = options?.signalCliUrl || '';
    this.attachmentsDir = options?.attachmentsDir || './data/signal-attachments';
    this.whisperModelPath = options?.whisperModelPath || './models/ggml-base.en.bin';
    this.timestampFormatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: this.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }

  private formatTimestamp(timestamp: number): string {
    const date = new Date(timestamp);
    const parts = this.timestampFormatter.formatToParts(date);
    const get = (type: string) => parts.find(p => p.type === type)?.value || '';
    return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
  }

  private formatMessageForContext(msg: Message): string {
    const ts = this.formatTimestamp(msg.timestamp);
    let content: string;
    if (msg.isBot) {
      content = `[${ts}] ${msg.content}`;
    } else {
      content = `[${ts}] ${msg.sender}: ${msg.content}`;
    }
    // Surface voice attachments from history so Claude can reference them
    const voiceAttachments = msg.attachments?.filter(a => a.contentType.startsWith('audio/'));
    if (voiceAttachments?.length) {
      const lines = voiceAttachments.map(a => `[Voice message attached: ${path.join(this.attachmentsDir, a.id)}]`);
      content = content ? `${content}\n${lines.join('\n')}` : lines.join('\n');
    }
    return content;
  }

  private fitToTokenBudget(messages: Message[]): Message[] {
    let totalTokens = 0;
    let cutoffIndex = messages.length;

    // Walk from newest to oldest
    for (let i = messages.length - 1; i >= 0; i--) {
      const formatted = this.formatMessageForContext(messages[i]);
      const tokens = Math.ceil(formatted.length / 4);
      if (totalTokens + tokens > this.contextTokenBudget) {
        cutoffIndex = i + 1;
        break;
      }
      totalTokens += tokens;
      cutoffIndex = i;
    }

    return messages.slice(cutoffIndex);
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

  buildContext(
    history: Message[],
    currentQuery: string,
    groupId?: string,
    sender?: string,
    dossierContext?: string,
    personaPrompt?: string,
  ): ChatMessage[] {
    let systemContent = personaPrompt || this.systemPrompt;

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
        `You have access to your own source code via the sourcecode tools (list_files, read_file, search_code). When asked how you work, what you can do, or technical questions about your implementation, use these tools to read the actual code before answering.`,
        `When a voice message is attached (shown as [Voice message attached: <path>] in the conversation), use the transcribe_audio tool to transcribe it, then respond to the transcribed content as if the user had typed it. Voice messages may appear in the current message or in recent conversation history.`,
      ].join('\n');

      const effectivePrompt = personaPrompt || this.systemPrompt;
      if (dossierContext) {
        systemContent = `${timeContext}\n\n${dossierContext}\n\n${PERSONA_SAFETY_PROMPT}\n\n${effectivePrompt}`;
      } else {
        systemContent = `${timeContext}\n\n${PERSONA_SAFETY_PROMPT}\n\n${effectivePrompt}`;
      }
    }

    const contextMessages: ChatMessage[] = [{ role: 'system', content: systemContent }];

    for (const msg of history) {
      contextMessages.push({
        role: msg.isBot ? 'assistant' : 'user',
        content: this.formatMessageForContext(msg),
      });
    }

    contextMessages.push({
      role: 'user',
      content: currentQuery,
    });

    return contextMessages;
  }

  async handleMessage(
    groupId: string,
    sender: string,
    content: string,
    timestamp: number,
    attachments: SignalAttachment[] = [],
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

    // Check for mention before storing so history fetch doesn't include current message
    const mentioned = this.isMentioned(content);

    // Get conversation history before storing current message (avoids duplication in context)
    let history: Message[] = [];
    if (mentioned) {
      const batch = this.storage.getRecentMessages(groupId, this.contextWindowSize);
      history = this.fitToTokenBudget(batch);
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

    if (!mentioned) {
      return;
    }

    // Start typing indicator (failure won't block response)
    try {
      await this.signalClient.sendTyping(groupId);
    } catch (typingError) {
      console.error('Failed to start typing indicator:', typingError);
    }

    // Refresh typing indicator every 10s to prevent Signal timeout
    const typingInterval = setInterval(async () => {
      try {
        await this.signalClient.sendTyping(groupId);
      } catch {
        // Non-fatal — indicator may briefly disappear
      }
    }, 10_000);

    try {
      // Extract query
      const query = this.extractQuery(content);

      // Filter voice attachments and append info to query
      const voiceAttachments = attachments.filter(a => a.contentType.startsWith('audio/'));
      let queryWithAttachments = query;
      if (voiceAttachments.length > 0) {
        const attachmentLines = voiceAttachments.map(
          a => `[Voice message attached: ${path.join(this.attachmentsDir, a.id)}]`,
        );
        queryWithAttachments = query ? `${query}\n\n${attachmentLines.join('\n')}` : attachmentLines.join('\n');
      }

      // Load dossiers for context injection
      let dossierContext = '';
      const dossiers = this.storage.getDossiersByGroup(groupId);
      if (dossiers.length > 0) {
        const entries = dossiers.map(d => {
          const parts = [`- ${d.displayName} (${d.personId})`];
          if (d.notes) parts.push(`  ${d.notes}`);
          return parts.join('\n');
        });
        dossierContext = `## People in this group\n${entries.join('\n')}`;
      }

      // Load skill instructions
      const skillContent = loadSkillContent();
      if (skillContent) {
        dossierContext = dossierContext ? `${dossierContext}\n\n${skillContent}` : skillContent;
      }

      // Look up active persona for this group
      const activePersona = this.storage.getActivePersonaForGroup(groupId);
      const personaPrompt = activePersona?.description;

      // Build context
      const messages = this.buildContext(history, queryWithAttachments, groupId, sender, dossierContext, personaPrompt);

      // Get LLM response
      const response = await this.llmClient.generateResponse(messages, {
        groupId,
        sender,
        dbPath: this.dbPath,
        timezone: this.timezone,
        githubRepo: this.githubRepo,
        sourceRoot: this.sourceRoot,
        signalCliUrl: this.signalCliUrl,
        botPhoneNumber: this.botPhoneNumber,
        attachmentsDir: this.attachmentsDir,
        whisperModelPath: this.whisperModelPath,
      });

      if (response.sentViaMcp) {
        // Claude sent messages directly — store each one
        for (const mcpMsg of response.mcpMessages) {
          this.storage.addMessage({
            groupId,
            sender: this.botPhoneNumber || 'bot',
            content: mcpMsg,
            timestamp: Date.now(),
            isBot: true,
          });
        }
      } else {
        // Fallback: Claude didn't use the MCP tool, send result as before
        await this.signalClient.sendMessage(groupId, response.content);
        this.storage.addMessage({
          groupId,
          sender: this.botPhoneNumber || 'bot',
          content: response.content,
          timestamp: Date.now(),
          isBot: true,
        });
      }

      // Trim old messages
      this.storage.trimMessages(groupId, this.messageRetentionCount);

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
    } finally {
      clearInterval(typingInterval);
      // Always stop typing indicator
      try {
        await this.signalClient.stopTyping(groupId);
      } catch (stopTypingError) {
        console.error('Failed to stop typing indicator:', stopTypingError);
      }
    }
  }
}
