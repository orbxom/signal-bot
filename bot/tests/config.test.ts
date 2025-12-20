import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Config } from '../src/config';

describe('Config', () => {
  // Store original environment variables
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear relevant environment variables before each test
    delete process.env.AZURE_OPENAI_ENDPOINT;
    delete process.env.AZURE_OPENAI_KEY;
    delete process.env.AZURE_OPENAI_DEPLOYMENT;
    delete process.env.BOT_PHONE_NUMBER;
    delete process.env.MENTION_TRIGGERS;
    delete process.env.CONTEXT_WINDOW_SIZE;
    delete process.env.SIGNAL_CLI_URL;
    delete process.env.DB_PATH;
  });

  afterEach(() => {
    // Restore original environment variables after each test
    process.env = { ...originalEnv };
  });

  it('should load configuration from environment', () => {
    process.env.AZURE_OPENAI_ENDPOINT = 'https://test.openai.azure.com/';
    process.env.AZURE_OPENAI_KEY = 'test-key';
    process.env.AZURE_OPENAI_DEPLOYMENT = 'gpt-4o';
    process.env.BOT_PHONE_NUMBER = '+1234567890';
    process.env.MENTION_TRIGGERS = '@bot,bot:';
    process.env.CONTEXT_WINDOW_SIZE = '20';

    const config = Config.load();
    expect(config.azureOpenAI.endpoint).toBe('https://test.openai.azure.com/');
    expect(config.azureOpenAI.key).toBe('test-key');
    expect(config.azureOpenAI.deployment).toBe('gpt-4o');
    expect(config.botPhoneNumber).toBe('+1234567890');
    expect(config.mentionTriggers).toEqual(['@bot', 'bot:']);
    expect(config.contextWindowSize).toBe(20);
  });

  it('should use default values for optional configuration', () => {
    process.env.AZURE_OPENAI_ENDPOINT = 'https://test.openai.azure.com/';
    process.env.AZURE_OPENAI_KEY = 'test-key';
    process.env.AZURE_OPENAI_DEPLOYMENT = 'gpt-4o';
    process.env.BOT_PHONE_NUMBER = '+1234567890';
    // Not setting MENTION_TRIGGERS, CONTEXT_WINDOW_SIZE, SIGNAL_CLI_URL, DB_PATH

    const config = Config.load();
    expect(config.mentionTriggers).toEqual(['@bot']);
    expect(config.contextWindowSize).toBe(20);
    expect(config.signalCliUrl).toBe('http://localhost:8080');
    expect(config.dbPath).toBe('./data/bot.db');
  });

  it('should throw error when AZURE_OPENAI_ENDPOINT is missing', () => {
    process.env.AZURE_OPENAI_KEY = 'test-key';
    process.env.AZURE_OPENAI_DEPLOYMENT = 'gpt-4o';
    process.env.BOT_PHONE_NUMBER = '+1234567890';

    expect(() => Config.load()).toThrow('Missing required Azure OpenAI configuration: AZURE_OPENAI_ENDPOINT');
  });

  it('should throw error when AZURE_OPENAI_KEY is missing', () => {
    process.env.AZURE_OPENAI_ENDPOINT = 'https://test.openai.azure.com/';
    process.env.AZURE_OPENAI_DEPLOYMENT = 'gpt-4o';
    process.env.BOT_PHONE_NUMBER = '+1234567890';

    expect(() => Config.load()).toThrow('Missing required Azure OpenAI configuration: AZURE_OPENAI_KEY');
  });

  it('should throw error when AZURE_OPENAI_DEPLOYMENT is missing', () => {
    process.env.AZURE_OPENAI_ENDPOINT = 'https://test.openai.azure.com/';
    process.env.AZURE_OPENAI_KEY = 'test-key';
    process.env.BOT_PHONE_NUMBER = '+1234567890';

    expect(() => Config.load()).toThrow('Missing required Azure OpenAI configuration: AZURE_OPENAI_DEPLOYMENT');
  });

  it('should throw error when multiple Azure OpenAI variables are missing', () => {
    process.env.BOT_PHONE_NUMBER = '+1234567890';

    expect(() => Config.load()).toThrow('Missing required Azure OpenAI configuration: AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_KEY, AZURE_OPENAI_DEPLOYMENT');
  });

  it('should throw error when BOT_PHONE_NUMBER is missing', () => {
    process.env.AZURE_OPENAI_ENDPOINT = 'https://test.openai.azure.com/';
    process.env.AZURE_OPENAI_KEY = 'test-key';
    process.env.AZURE_OPENAI_DEPLOYMENT = 'gpt-4o';

    expect(() => Config.load()).toThrow('Missing required configuration: BOT_PHONE_NUMBER');
  });

  it('should throw error when CONTEXT_WINDOW_SIZE is not a number', () => {
    process.env.AZURE_OPENAI_ENDPOINT = 'https://test.openai.azure.com/';
    process.env.AZURE_OPENAI_KEY = 'test-key';
    process.env.AZURE_OPENAI_DEPLOYMENT = 'gpt-4o';
    process.env.BOT_PHONE_NUMBER = '+1234567890';
    process.env.CONTEXT_WINDOW_SIZE = 'abc';

    expect(() => Config.load()).toThrow('CONTEXT_WINDOW_SIZE must be a positive number');
  });

  it('should throw error when CONTEXT_WINDOW_SIZE is zero', () => {
    process.env.AZURE_OPENAI_ENDPOINT = 'https://test.openai.azure.com/';
    process.env.AZURE_OPENAI_KEY = 'test-key';
    process.env.AZURE_OPENAI_DEPLOYMENT = 'gpt-4o';
    process.env.BOT_PHONE_NUMBER = '+1234567890';
    process.env.CONTEXT_WINDOW_SIZE = '0';

    expect(() => Config.load()).toThrow('CONTEXT_WINDOW_SIZE must be a positive number');
  });

  it('should throw error when CONTEXT_WINDOW_SIZE is negative', () => {
    process.env.AZURE_OPENAI_ENDPOINT = 'https://test.openai.azure.com/';
    process.env.AZURE_OPENAI_KEY = 'test-key';
    process.env.AZURE_OPENAI_DEPLOYMENT = 'gpt-4o';
    process.env.BOT_PHONE_NUMBER = '+1234567890';
    process.env.CONTEXT_WINDOW_SIZE = '-5';

    expect(() => Config.load()).toThrow('CONTEXT_WINDOW_SIZE must be a positive number');
  });

  it('should handle mention triggers with trailing commas', () => {
    process.env.AZURE_OPENAI_ENDPOINT = 'https://test.openai.azure.com/';
    process.env.AZURE_OPENAI_KEY = 'test-key';
    process.env.AZURE_OPENAI_DEPLOYMENT = 'gpt-4o';
    process.env.BOT_PHONE_NUMBER = '+1234567890';
    process.env.MENTION_TRIGGERS = '@bot,bot:,';

    const config = Config.load();
    expect(config.mentionTriggers).toEqual(['@bot', 'bot:']);
  });

  it('should handle mention triggers with extra whitespace', () => {
    process.env.AZURE_OPENAI_ENDPOINT = 'https://test.openai.azure.com/';
    process.env.AZURE_OPENAI_KEY = 'test-key';
    process.env.AZURE_OPENAI_DEPLOYMENT = 'gpt-4o';
    process.env.BOT_PHONE_NUMBER = '+1234567890';
    process.env.MENTION_TRIGGERS = ' @bot , bot: , hey bot ';

    const config = Config.load();
    expect(config.mentionTriggers).toEqual(['@bot', 'bot:', 'hey bot']);
  });

  it('should handle mention triggers with empty strings between commas', () => {
    process.env.AZURE_OPENAI_ENDPOINT = 'https://test.openai.azure.com/';
    process.env.AZURE_OPENAI_KEY = 'test-key';
    process.env.AZURE_OPENAI_DEPLOYMENT = 'gpt-4o';
    process.env.BOT_PHONE_NUMBER = '+1234567890';
    process.env.MENTION_TRIGGERS = '@bot,,bot:,,,';

    const config = Config.load();
    expect(config.mentionTriggers).toEqual(['@bot', 'bot:']);
  });
});
