import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readStorageEnv, readTimezone } from '../../src/mcp/env';

describe('mcp/env', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('readStorageEnv', () => {
    it('reads DB_PATH, MCP_GROUP_ID, MCP_SENDER from process.env', () => {
      process.env.DB_PATH = '/tmp/test.db';
      process.env.MCP_GROUP_ID = 'group-123';
      process.env.MCP_SENDER = '+61400000000';

      const result = readStorageEnv();
      expect(result.dbPath).toBe('/tmp/test.db');
      expect(result.groupId).toBe('group-123');
      expect(result.sender).toBe('+61400000000');
    });

    it('uses defaults when env vars missing', () => {
      delete process.env.DB_PATH;
      delete process.env.MCP_GROUP_ID;
      delete process.env.MCP_SENDER;

      const result = readStorageEnv();
      expect(result.dbPath).toBe('./data/bot.db');
      expect(result.groupId).toBe('');
      expect(result.sender).toBe('');
    });
  });

  describe('readTimezone', () => {
    it('reads TZ from process.env', () => {
      process.env.TZ = 'America/New_York';
      expect(readTimezone()).toBe('America/New_York');
    });

    it('defaults to Australia/Sydney', () => {
      delete process.env.TZ;
      expect(readTimezone()).toBe('Australia/Sydney');
    });
  });
});
