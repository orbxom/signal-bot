export interface Message {
  id: number;
  groupId: string;
  sender: string;
  content: string;
  timestamp: number;
  isBot: boolean;
  attachments?: SignalAttachment[];
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMResponse {
  content: string;
  tokensUsed: number;
  sentViaMcp: boolean;
  mcpMessages: string[];
}

export type ReminderStatus = 'pending' | 'sent' | 'cancelled' | 'failed';

export interface Reminder {
  id: number;
  groupId: string;
  requester: string;
  reminderText: string;
  dueAt: number;
  status: ReminderStatus;
  retryCount: number;
  createdAt: number;
  sentAt: number | null;
  lastAttemptAt: number | null;
  failureReason: string | null;
  mode: ReminderMode;
}

export type ReminderMode = 'simple' | 'prompt';

/** Minimal interface for spawning a Claude prompt session. Used by both one-off and recurring reminders. */
export interface PromptExecution {
  id: number;
  groupId: string;
  requester: string;
  promptText: string;
  timezone?: string;
}

export type RecurringReminderStatus = 'active' | 'cancelled';

export interface RecurringReminder {
  id: number;
  groupId: string;
  requester: string;
  promptText: string;
  cronExpression: string;
  timezone: string;
  nextDueAt: number;
  status: RecurringReminderStatus;
  consecutiveFailures: number;
  lastFiredAt: number | null;
  lastInFlightAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface Dossier {
  id: number;
  groupId: string;
  personId: string;
  displayName: string;
  notes: string;
  createdAt: number;
  updatedAt: number;
}

export interface Memory {
  id: number;
  groupId: string;
  topic: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

export interface Persona {
  id: number;
  name: string;
  description: string;
  tags: string;
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ActivePersona {
  groupId: string;
  personaId: number;
  activatedAt: number;
}

/** Static application configuration — does not change per request. */
export interface AppConfig {
  dbPath: string;
  timezone: string;
  githubRepo: string;
  sourceRoot: string;
  signalCliUrl: string;
  botPhoneNumber: string;
  attachmentsDir: string;
  whisperModelPath: string;
  darkFactoryEnabled: string;
  darkFactoryProjectRoot: string;
}

/** Per-message request context. */
export interface RequestContext {
  groupId: string;
  sender: string;
  toolNotificationsEnabled?: boolean;
}

/** Combined context — backward-compatible alias. */
export type MessageContext = AppConfig & RequestContext;

/** Interface for LLM clients (enables testing without real CLI). */
export interface LLMClient {
  generateResponse(messages: ChatMessage[], context?: MessageContext): Promise<LLMResponse>;
}

export interface SignalAttachment {
  id: string;
  contentType: string;
  size: number;
  filename: string | null;
}

export interface SignalMessage {
  envelope: {
    source?: string;
    sourceNumber?: string;
    sourceUuid?: string;
    timestamp: number;
    dataMessage?: {
      timestamp: number;
      message?: string;
      groupInfo?: {
        groupId: string;
      };
      attachments?: SignalAttachment[];
    };
  };
}

export interface ExtractedMessage {
  sender: string;
  content: string;
  groupId: string;
  timestamp: number;
  attachments: SignalAttachment[];
}

export interface Attachment {
  id: string;
  groupId: string;
  sender: string;
  contentType: string;
  size: number;
  filename: string | null;
  data: Buffer; // raw binary, stored as BLOB in SQLite
  timestamp: number;
}
