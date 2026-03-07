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
  attachmentsDir: string;
  whisperModelPath: string;
  testChannelOnly: boolean;
  testGroupId: string;
  collaborativeTestingMode: boolean;
}

const DEFAULT_SYSTEM_PROMPT =
  'You are a helpful family assistant in a Signal group chat. Be friendly, concise, and helpful. Keep responses under a few sentences unless asked for detail.\n\nYou can send messages to the group chat using the send_message tool. When you receive a request:\n1. Send a brief acknowledgment showing you understand what was asked (not generic — reference the actual request)\n2. Do your work (call tools, look things up, etc.)\n3. Send your final response via send_message\n\nFor simple greetings or short replies, a single send_message call is fine — no need to acknowledge first.\nAlways use send_message for your responses.';

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
      .map(s => s.trimStart())
      .filter(s => s.length > 0);

    const testChannelOnly = process.argv.includes('--test-channel-only') || process.env.TEST_CHANNEL_ONLY === 'true';
    const testGroupId = process.env.TEST_GROUP_ID || 'kKWs+FQPBZKe7N7CdxMjNAAjE2uWEmtBij55MOfWFU4=';
    const collaborativeTestingMode = process.env.COLLABORATIVE_TESTING === 'true';

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
      attachmentsDir: process.env.ATTACHMENTS_DIR || './data/signal-attachments',
      whisperModelPath: process.env.WHISPER_MODEL_PATH || './models/ggml-base.en.bin',
      darkFactoryEnabled: process.env.DARK_FACTORY_ENABLED || '',
      darkFactoryProjectRoot: process.env.DARK_FACTORY_PROJECT_ROOT || '',
      testChannelOnly,
      testGroupId,
      collaborativeTestingMode,
    };
  }
}
