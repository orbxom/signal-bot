import { config as loadEnv } from 'dotenv';

loadEnv();

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
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
    const key = process.env.AZURE_OPENAI_KEY;
    const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;

    if (!endpoint || !key || !deployment) {
      throw new Error('Missing required Azure OpenAI configuration');
    }

    return {
      azureOpenAI: {
        endpoint,
        key,
        deployment
      },
      botPhoneNumber: process.env.BOT_PHONE_NUMBER || '',
      mentionTriggers: (process.env.MENTION_TRIGGERS || '@bot').split(','),
      contextWindowSize: parseInt(process.env.CONTEXT_WINDOW_SIZE || '20', 10),
      signalCliUrl: process.env.SIGNAL_CLI_URL || 'http://localhost:8080',
      dbPath: process.env.DB_PATH || './data/bot.db'
    };
  }
}
