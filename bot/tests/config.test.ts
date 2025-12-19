import { describe, it, expect, beforeEach } from 'vitest';
import { Config } from '../src/config';

describe('Config', () => {
  it('should load configuration from environment', () => {
    process.env.AZURE_OPENAI_ENDPOINT = 'https://test.openai.azure.com/';
    process.env.AZURE_OPENAI_KEY = 'test-key';
    process.env.AZURE_OPENAI_DEPLOYMENT = 'gpt-4o';
    process.env.MENTION_TRIGGERS = '@bot,bot:';
    process.env.CONTEXT_WINDOW_SIZE = '20';

    const config = Config.load();
    expect(config.azureOpenAI.endpoint).toBe('https://test.openai.azure.com/');
    expect(config.azureOpenAI.key).toBe('test-key');
    expect(config.mentionTriggers).toEqual(['@bot', 'bot:']);
    expect(config.contextWindowSize).toBe(20);
  });
});
