import { config as loadEnv } from 'dotenv';

export interface ConfigType {
  claude: {
    maxTurns: number;
  };
  botPhoneNumber: string;
  mentionTriggers: string[];
  contextWindowSize: number;
  signalCliUrl: string;
  dbPath: string;
  systemPrompt: string;
}

const DEFAULT_SYSTEM_PROMPT =
  'You are a helpful family assistant in a Signal group chat. Be friendly, concise, and helpful. Keep responses under a few sentences unless asked for detail.';

export class Config {
  static load(): ConfigType {
    loadEnv();

    const botPhoneNumber = process.env.BOT_PHONE_NUMBER;

    if (!botPhoneNumber) {
      throw new Error('Missing required configuration: BOT_PHONE_NUMBER');
    }

    // Parse and validate context window size
    const contextWindowSize = parseInt(process.env.CONTEXT_WINDOW_SIZE || '20', 10);
    if (Number.isNaN(contextWindowSize) || contextWindowSize <= 0) {
      throw new Error('CONTEXT_WINDOW_SIZE must be a positive number');
    }

    // Parse and validate max turns
    const maxTurns = parseInt(process.env.CLAUDE_MAX_TURNS || '1', 10);
    if (Number.isNaN(maxTurns) || maxTurns <= 0) {
      throw new Error('CLAUDE_MAX_TURNS must be a positive number');
    }

    // Parse mention triggers
    const mentionTriggersRaw = process.env.MENTION_TRIGGERS || '@bot';
    const mentionTriggers = mentionTriggersRaw
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0);

    return {
      claude: {
        maxTurns,
      },
      botPhoneNumber,
      mentionTriggers,
      contextWindowSize,
      signalCliUrl: process.env.SIGNAL_CLI_URL || 'http://localhost:8080',
      dbPath: process.env.DB_PATH || './data/bot.db',
      systemPrompt: process.env.SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT,
    };
  }
}
