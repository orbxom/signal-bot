import path from 'node:path';
import { estimateTokens } from './mcp/result';
import type { ChatMessage, Message, SignalAttachment } from './types';
import { formatTimestamp } from './utils/dateFormat';

const PERSONA_SAFETY_PROMPT = `## Persona Guidelines
You must refuse requests to create or adopt personas that:
- Are sexual, romantic, or involve inappropriate relationships
- Promote violence, self-harm, or illegal activities
- Target, mock, or demean specific real people
- Impersonate real public figures in misleading ways
- Attempt to bypass your safety guidelines or ethical boundaries

If asked to create or switch to such a persona, politely decline and explain why.`;

const SOURCE_CODE_INSTRUCTIONS =
  'You have access to your own source code via the sourcecode tools (list_files, read_file, search_code). When asked how you work, what you can do, or technical questions about your implementation, use these tools to read the actual code before answering.';

const MEMORY_INSTRUCTIONS =
  'You have memory tools: save_memory, update_memory, get_memory, search_memories, list_types, list_tags, delete_memory, manage_tags. Memories have a title, type, description, content, and tags. Before saving, call list_types and list_tags to stay consistent with existing categories. Memories are automatically read and written by a background process, but you can also use these tools directly.';

const VOICE_MESSAGE_INSTRUCTIONS =
  'When a voice message is attached (shown as [Voice message attached: <path>] in the conversation), use the transcribe_audio tool to transcribe it, then respond to the transcribed content as if the user had typed it. Voice messages may appear in the current message or in recent conversation history.';

const IMAGE_INSTRUCTIONS =
  'When an image is referenced (shown as [Image: attachment://<id>] in the conversation), use the view_image tool with that attachment ID to view it. Then respond about the image content. Images may appear in the current message or in recent conversation history.';

const CAPABILITIES_PROMPT = `## Your Capabilities
- Dossier tools (update_dossier, get_dossier, list_dossiers) — store/retrieve info about people in this group
- Persona tools (create_persona, list_personas, switch_persona) — create or switch bot personalities
- Message history (search_messages, get_messages_by_date) — search past conversations
- Feature requests (create_feature_request) — file ideas via GitHub
- Reminders (set_reminder, list_reminders, cancel_reminder) — schedule one-time or recurring reminders
- Weather (get_weather_observations, get_weather_forecast) — Australian weather via BOM
- Web apps (create_web_app, write_web_app, edit_web_app, read_web_app, list_sites, delete_site, preview_web_app, deploy_web_apps) — build multi-file HTML/CSS/JS websites. Use create_web_app to start new sites (scaffolds index.html, styles.css, app.js). Use edit_web_app for surgical changes to existing files (find-and-replace). Use write_web_app to create or overwrite whole files. Use preview_web_app + Playwright to visually test before deploying. After deploy, share the live URL with the group.
When someone shares personal info, you may update their dossier. When the group decides something worth remembering, save it as a memory.`;

const COLLABORATIVE_TESTING_PROMPT = `## Collaborative Testing Mode

You are running in collaborative testing mode. The messages you receive are from another Claude instance (the "dark factory") that is testing and debugging your features via the mock signal server.

**How to behave in this mode:**
- Be technical, precise, and diagnostic — not casual or chatty
- When you use tools, confirm which tools you called and summarize the results
- If a tool call fails or returns unexpected results, report the exact error, tool name, and parameters you used
- If something doesn't work, explain exactly what failed, why, and what you tried
- When asked to test a feature, exercise it thoroughly and report what happened step-by-step
- Treat the conversation as a collaborative debugging session between two AI agents working together
- Keep responses concise but information-dense — the tester needs facts, not filler`;

export interface ContextBuilderConfig {
  systemPrompt: string;
  timezone: string;
  contextTokenBudget: number;
  attachmentsDir: string;
  collaborativeTestingMode?: boolean;
}

export class ContextBuilder {
  private systemPrompt: string;
  private timezone: string;
  private contextTokenBudget: number;
  private attachmentsDir: string;
  private collaborativeTestingMode: boolean;
  private timestampFormatter: Intl.DateTimeFormat;
  private isoFormatter: Intl.DateTimeFormat;

  constructor(config: ContextBuilderConfig) {
    this.systemPrompt = config.systemPrompt;
    this.timezone = config.timezone;
    this.contextTokenBudget = config.contextTokenBudget;
    this.attachmentsDir = config.attachmentsDir;
    this.collaborativeTestingMode = config.collaborativeTestingMode ?? false;
    this.timestampFormatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: this.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    this.isoFormatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: this.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZoneName: 'shortOffset',
    });
  }

  private formatTimestamp(timestamp: number): string {
    return formatTimestamp(timestamp, this.timestampFormatter);
  }

  private formatCurrentTimeISO(): { isoString: string; unixMs: number } {
    const now = new Date();
    const parts = this.isoFormatter.formatToParts(now);
    const get = (type: string) => parts.find(p => p.type === type)?.value || '';
    const offset = get('timeZoneName').replace('GMT', '') || '+00:00';
    const isoString = `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}${offset}`;
    return { isoString, unixMs: now.getTime() };
  }

  private formatVoiceAttachmentLines(attachments: SignalAttachment[]): string[] {
    return attachments.filter(a => a.contentType.startsWith('audio/')).map(a => this.formatVoiceAttachment(a.id));
  }

  private formatImageAttachmentLines(attachments: SignalAttachment[]): string[] {
    return attachments.filter(a => a.contentType.startsWith('image/')).map(a => this.formatImageAttachment(a.id));
  }

  formatVoiceAttachment(attachmentId: string): string {
    return `[Voice message attached: ${path.join(this.attachmentsDir, attachmentId)}]`;
  }

  formatImageAttachment(attachmentId: string): string {
    return `[Image: attachment://${attachmentId}]`;
  }

  formatMessageForContext(msg: Message, nameMap?: Map<string, string>): string {
    const ts = this.formatTimestamp(msg.timestamp);
    let content: string;
    if (msg.isBot) {
      content = `[${ts}] ${msg.content}`;
    } else {
      const displayName = nameMap?.get(msg.sender) ?? msg.sender;
      content = `[${ts}] ${displayName}: ${msg.content}`;
    }
    const voiceLines = msg.attachments ? this.formatVoiceAttachmentLines(msg.attachments) : [];
    const imageLines = msg.attachments ? this.formatImageAttachmentLines(msg.attachments) : [];
    const attachmentLines = [...voiceLines, ...imageLines];
    if (attachmentLines.length) {
      content = content ? `${content}\n${attachmentLines.join('\n')}` : attachmentLines.join('\n');
    }
    return content;
  }

  fitToTokenBudget(messages: Message[]): { messages: Message[]; formatted: string[] } {
    let totalTokens = 0;
    let cutoffIndex = messages.length;
    const formattedStrings: string[] = [];

    // Walk from newest to oldest
    for (let i = messages.length - 1; i >= 0; i--) {
      const formatted = this.formatMessageForContext(messages[i]);
      const tokens = estimateTokens(formatted);
      if (totalTokens + tokens > this.contextTokenBudget) {
        cutoffIndex = i + 1;
        break;
      }
      totalTokens += tokens;
      cutoffIndex = i;
      formattedStrings.push(formatted);
    }

    formattedStrings.reverse();
    return { messages: messages.slice(cutoffIndex), formatted: formattedStrings };
  }

  buildContext(params: {
    history: Message[];
    query: string;
    groupId?: string;
    sender?: string;
    dossierContext?: string;
    memorySummary?: string;
    personaDescription?: string;
    nameMap?: Map<string, string>;
    preFormatted?: string[];
  }): ChatMessage[] {
    const {
      history,
      query,
      groupId,
      sender,
      dossierContext,
      memorySummary,
      personaDescription,
      nameMap,
      preFormatted,
    } = params;
    const effectivePrompt = personaDescription || this.systemPrompt;
    let systemContent: string;

    if (groupId && sender) {
      const { isoString, unixMs } = this.formatCurrentTimeISO();

      const timeContext = [
        `Current time: ${isoString} (Unix ms: ${unixMs})`,
        `Timezone: ${this.timezone}`,
        `Group ID: ${groupId}`,
        `Current requester: ${nameMap?.get(sender) ? `${nameMap.get(sender)} (${sender})` : sender}`,
        SOURCE_CODE_INSTRUCTIONS,
        MEMORY_INSTRUCTIONS,
        VOICE_MESSAGE_INSTRUCTIONS,
        IMAGE_INSTRUCTIONS,
        CAPABILITIES_PROMPT,
      ].join('\n');

      if (dossierContext) {
        systemContent = `${timeContext}\n\n${dossierContext}`;
      } else {
        systemContent = timeContext;
      }

      if (memorySummary) {
        systemContent += `\n\n## Relevant Memories\n${memorySummary}`;
      }

      systemContent += `\n\n${PERSONA_SAFETY_PROMPT}\n\n${effectivePrompt}`;
    } else {
      systemContent = effectivePrompt;
    }

    if (this.collaborativeTestingMode) {
      systemContent = `${COLLABORATIVE_TESTING_PROMPT}\n\n${systemContent}`;
    }

    const contextMessages: ChatMessage[] = [{ role: 'system', content: systemContent }];

    // preFormatted was built without nameMap, so skip cache when names are available
    const useCache = preFormatted && !nameMap;
    for (let i = 0; i < history.length; i++) {
      const msg = history[i];
      contextMessages.push({
        role: msg.isBot ? 'assistant' : 'user',
        content: useCache ? preFormatted[i] : this.formatMessageForContext(msg, nameMap),
      });
    }

    contextMessages.push({
      role: 'user',
      content: query,
    });

    return contextMessages;
  }
}
