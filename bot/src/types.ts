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

export interface Persona {
  id: number;
  name: string;
  description: string;
  tags: string;
  isDefault: number;
  createdAt: number;
  updatedAt: number;
}

export interface ActivePersona {
  groupId: string;
  personaId: number;
  activatedAt: number;
}

export interface MessageContext {
  groupId: string;
  sender: string;
  dbPath: string;
  timezone: string;
  githubRepo: string;
  sourceRoot: string;
  signalCliUrl: string;
  botPhoneNumber: string;
  attachmentsDir: string;
  whisperModelPath: string;
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
