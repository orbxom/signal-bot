import path from 'node:path';
import { config as loadEnv } from 'dotenv';

export interface ConfigType {
  claude: {
    maxTurns: number;
  };
  botPhoneNumber: string;
  mentionTriggers: string[];
  contextWindowSize: number;
  contextTokenBudget: number;
  messageRetentionCount: number;
  signalCliUrl: string;
  dbPath: string;
  systemPrompt: string;
  timezone: string;
  githubRepo: string;
  sourceRoot: string;
  testChannelOnly: boolean;
  testGroupId: string;
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

    // Parse and validate context window size (max batch fetch from DB for token-budget consideration)
    const contextWindowSize = parseInt(process.env.CONTEXT_WINDOW_SIZE || '200', 10);
    if (Number.isNaN(contextWindowSize) || contextWindowSize <= 0) {
      throw new Error('CONTEXT_WINDOW_SIZE must be a positive number');
    }

    // Parse and validate context token budget
    const contextTokenBudget = parseInt(process.env.CONTEXT_TOKEN_BUDGET || '4000', 10);
    if (Number.isNaN(contextTokenBudget) || contextTokenBudget <= 0) {
      throw new Error('CONTEXT_TOKEN_BUDGET must be a positive number');
    }

    // Parse and validate message retention count
    const messageRetentionCount = parseInt(process.env.MESSAGE_RETENTION_COUNT || '1000', 10);
    if (Number.isNaN(messageRetentionCount) || messageRetentionCount <= 0) {
      throw new Error('MESSAGE_RETENTION_COUNT must be a positive number');
    }

    // Parse and validate max turns
    const maxTurns = parseInt(process.env.CLAUDE_MAX_TURNS || '25', 10);
    if (Number.isNaN(maxTurns) || maxTurns <= 0) {
      throw new Error('CLAUDE_MAX_TURNS must be a positive number');
    }

    // Parse mention triggers
    const mentionTriggersRaw = process.env.MENTION_TRIGGERS || '@bot';
    const mentionTriggers = mentionTriggersRaw
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0);

    const testChannelOnly = process.argv.includes('--test-channel-only') || process.env.TEST_CHANNEL_ONLY === 'true';
    const testGroupId = process.env.TEST_GROUP_ID || 'kKWs+FQPBZKe7N7CdxMjNAAjE2uWEmtBij55MOfWFU4=';

    return {
      claude: {
        maxTurns,
      },
      botPhoneNumber,
      mentionTriggers,
      contextWindowSize,
      contextTokenBudget,
      messageRetentionCount,
      signalCliUrl: process.env.SIGNAL_CLI_URL || 'http://localhost:8080',
      dbPath: process.env.DB_PATH || './data/bot.db',
      systemPrompt: process.env.SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT,
      timezone: process.env.BOT_TIMEZONE || 'Australia/Sydney',
      githubRepo: process.env.GITHUB_REPO || '',
      sourceRoot: process.env.SOURCE_ROOT || path.resolve(__dirname, '..'),
      testChannelOnly,
      testGroupId,
    };
  }
}
