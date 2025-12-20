import { config as loadEnv } from 'dotenv';

export interface ConfigType {
  azureOpenAI: {
    endpoint: string;
    key: string;
    deployment: string;
  };
  botPhoneNumber: string;
  mentionTriggers: string[];
  contextWindowSize: number;
  signalCliUrl: string;
  dbPath: string;
}

export class Config {
  static load(): ConfigType {
    // Load environment variables at the start of load()
    loadEnv();

    const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
    const key = process.env.AZURE_OPENAI_KEY;
    const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;
    const botPhoneNumber = process.env.BOT_PHONE_NUMBER;

    // Validate required Azure OpenAI configuration
    const missingAzureVars: string[] = [];
    if (!endpoint) missingAzureVars.push('AZURE_OPENAI_ENDPOINT');
    if (!key) missingAzureVars.push('AZURE_OPENAI_KEY');
    if (!deployment) missingAzureVars.push('AZURE_OPENAI_DEPLOYMENT');

    if (missingAzureVars.length > 0) {
      throw new Error(`Missing required Azure OpenAI configuration: ${missingAzureVars.join(', ')}`);
    }

    // Validate required bot phone number
    if (!botPhoneNumber) {
      throw new Error('Missing required configuration: BOT_PHONE_NUMBER');
    }

    // Parse and validate context window size
    const contextWindowSize = parseInt(process.env.CONTEXT_WINDOW_SIZE || '20', 10);
    if (isNaN(contextWindowSize) || contextWindowSize <= 0) {
      throw new Error('CONTEXT_WINDOW_SIZE must be a positive number');
    }

    // Parse mention triggers with proper trimming and filtering
    const mentionTriggersRaw = process.env.MENTION_TRIGGERS || '@bot';
    const mentionTriggers = mentionTriggersRaw
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0);

    return {
      azureOpenAI: {
        endpoint,
        key,
        deployment
      },
      botPhoneNumber,
      mentionTriggers,
      contextWindowSize,
      signalCliUrl: process.env.SIGNAL_CLI_URL || 'http://localhost:8080',
      dbPath: process.env.DB_PATH || './data/bot.db'
    };
  }
}
