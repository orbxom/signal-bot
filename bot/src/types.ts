export interface Message {
  id: number;
  groupId: string;
  sender: string;
  content: string;
  timestamp: number;
  isBot: boolean;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMResponse {
  content: string;
  tokensUsed: number;
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
    };
  };
}
