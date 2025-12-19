export interface Message {
  id: number;
  groupId: string;
  sender: string;
  content: string;
  timestamp: number;
  isBot: boolean;
}

export interface BotConfig {
  key: string;
  value: string;
}
