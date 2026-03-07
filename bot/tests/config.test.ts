import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('dotenv', () => ({
  config: vi.fn(),
}));

import { Config } from '../src/config';

describe('Config', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.BOT_PHONE_NUMBER;
    delete process.env.MENTION_TRIGGERS;
    delete process.env.CONTEXT_WINDOW_SIZE;
    delete process.env.CONTEXT_TOKEN_BUDGET;
    delete process.env.MESSAGE_RETENTION_COUNT;
    delete process.env.SIGNAL_CLI_URL;
    delete process.env.DB_PATH;
    delete process.env.SYSTEM_PROMPT;
    delete process.env.CLAUDE_MAX_TURNS;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('should load configuration from environment', () => {
    process.env.BOT_PHONE_NUMBER = '+1234567890';
    process.env.MENTION_TRIGGERS = '@bot,bot:';
    process.env.CONTEXT_WINDOW_SIZE = '20';
    process.env.CONTEXT_TOKEN_BUDGET = '8000';
    process.env.MESSAGE_RETENTION_COUNT = '500';
    process.env.SYSTEM_PROMPT = 'Custom prompt';
    process.env.CLAUDE_MAX_TURNS = '2';

    const config = Config.load();
    expect(config.botPhoneNumber).toBe('+1234567890');
    expect(config.mentionTriggers).toEqual(['@bot', 'bot:']);
    expect(config.contextWindowSize).toBe(20);
    expect(config.contextTokenBudget).toBe(8000);
    expect(config.messageRetentionCount).toBe(500);
    expect(config.systemPrompt).toBe('Custom prompt');
    expect(config.claude.maxTurns).toBe(2);
  });

  it('should use default values for optional configuration', () => {
    process.env.BOT_PHONE_NUMBER = '+1234567890';

    const config = Config.load();
    expect(config.mentionTriggers).toEqual(['@bot']);
    expect(config.contextWindowSize).toBe(200);
    expect(config.contextTokenBudget).toBe(4000);
    expect(config.messageRetentionCount).toBe(1000);
    expect(config.signalCliUrl).toBe('http://localhost:8080');
    expect(config.dbPath).toBe('./data/bot.db');
    expect(config.systemPrompt).toContain('helpful family assistant');
    expect(config.claude.maxTurns).toBe(25);
  });

  it('should throw error when BOT_PHONE_NUMBER is missing', () => {
    expect(() => Config.load()).toThrow('Missing required configuration: BOT_PHONE_NUMBER');
  });

  it('should throw error when CONTEXT_WINDOW_SIZE is not a number', () => {
    process.env.BOT_PHONE_NUMBER = '+1234567890';
    process.env.CONTEXT_WINDOW_SIZE = 'abc';

    expect(() => Config.load()).toThrow('CONTEXT_WINDOW_SIZE must be a positive number');
  });

  it('should throw error when CONTEXT_WINDOW_SIZE is zero', () => {
    process.env.BOT_PHONE_NUMBER = '+1234567890';
    process.env.CONTEXT_WINDOW_SIZE = '0';

    expect(() => Config.load()).toThrow('CONTEXT_WINDOW_SIZE must be a positive number');
  });

  it('should throw error when CONTEXT_WINDOW_SIZE is negative', () => {
    process.env.BOT_PHONE_NUMBER = '+1234567890';
    process.env.CONTEXT_WINDOW_SIZE = '-5';

    expect(() => Config.load()).toThrow('CONTEXT_WINDOW_SIZE must be a positive number');
  });

  it('should throw error when CLAUDE_MAX_TURNS is not a number', () => {
    process.env.BOT_PHONE_NUMBER = '+1234567890';
    process.env.CLAUDE_MAX_TURNS = 'abc';

    expect(() => Config.load()).toThrow('CLAUDE_MAX_TURNS must be a positive number');
  });

  it('should throw error when CLAUDE_MAX_TURNS is zero', () => {
    process.env.BOT_PHONE_NUMBER = '+1234567890';
    process.env.CLAUDE_MAX_TURNS = '0';

    expect(() => Config.load()).toThrow('CLAUDE_MAX_TURNS must be a positive number');
  });

  it('should throw error when CONTEXT_TOKEN_BUDGET is not a number', () => {
    process.env.BOT_PHONE_NUMBER = '+1234567890';
    process.env.CONTEXT_TOKEN_BUDGET = 'abc';

    expect(() => Config.load()).toThrow('CONTEXT_TOKEN_BUDGET must be a positive number');
  });

  it('should throw error when CONTEXT_TOKEN_BUDGET is zero', () => {
    process.env.BOT_PHONE_NUMBER = '+1234567890';
    process.env.CONTEXT_TOKEN_BUDGET = '0';

    expect(() => Config.load()).toThrow('CONTEXT_TOKEN_BUDGET must be a positive number');
  });

  it('should throw error when CONTEXT_TOKEN_BUDGET is negative', () => {
    process.env.BOT_PHONE_NUMBER = '+1234567890';
    process.env.CONTEXT_TOKEN_BUDGET = '-100';

    expect(() => Config.load()).toThrow('CONTEXT_TOKEN_BUDGET must be a positive number');
  });

  it('should throw error when MESSAGE_RETENTION_COUNT is not a number', () => {
    process.env.BOT_PHONE_NUMBER = '+1234567890';
    process.env.MESSAGE_RETENTION_COUNT = 'abc';

    expect(() => Config.load()).toThrow('MESSAGE_RETENTION_COUNT must be a positive number');
  });

  it('should throw error when MESSAGE_RETENTION_COUNT is zero', () => {
    process.env.BOT_PHONE_NUMBER = '+1234567890';
    process.env.MESSAGE_RETENTION_COUNT = '0';

    expect(() => Config.load()).toThrow('MESSAGE_RETENTION_COUNT must be a positive number');
  });

  it('should throw error when MESSAGE_RETENTION_COUNT is negative', () => {
    process.env.BOT_PHONE_NUMBER = '+1234567890';
    process.env.MESSAGE_RETENTION_COUNT = '-50';

    expect(() => Config.load()).toThrow('MESSAGE_RETENTION_COUNT must be a positive number');
  });

  it('should handle mention triggers with trailing commas', () => {
    process.env.BOT_PHONE_NUMBER = '+1234567890';
    process.env.MENTION_TRIGGERS = '@bot,bot:,';

    const config = Config.load();
    expect(config.mentionTriggers).toEqual(['@bot', 'bot:']);
  });

  it('should handle mention triggers with extra whitespace', () => {
    process.env.BOT_PHONE_NUMBER = '+1234567890';
    process.env.MENTION_TRIGGERS = ' @bot , bot: , hey bot ';

    const config = Config.load();
    expect(config.mentionTriggers).toEqual(['@bot ', 'bot: ', 'hey bot ']);
  });

  it('should handle mention triggers with empty strings between commas', () => {
    process.env.BOT_PHONE_NUMBER = '+1234567890';
    process.env.MENTION_TRIGGERS = '@bot,,bot:,,,';

    const config = Config.load();
    expect(config.mentionTriggers).toEqual(['@bot', 'bot:']);
  });

  it('should preserve trailing whitespace in mention triggers', () => {
    process.env.BOT_PHONE_NUMBER = '+1234567890';
    process.env.MENTION_TRIGGERS = 'claude:,c ';

    const config = Config.load();
    expect(config.mentionTriggers).toEqual(['claude:', 'c ']);
  });
});
