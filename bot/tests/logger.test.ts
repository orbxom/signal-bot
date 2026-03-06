import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock node:fs before importing Logger
vi.mock('node:fs', () => ({
  mkdirSync: vi.fn(),
  appendFileSync: vi.fn(),
  existsSync: vi.fn(() => true),
}));

import { appendFileSync, mkdirSync } from 'node:fs';
import { Logger } from '../src/logger';

describe('Logger', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let logger: Logger;

  beforeEach(() => {
    vi.clearAllMocks();
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    logger = new Logger({ logDir: '/tmp/test-logs' });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  describe('constructor', () => {
    it('creates log directory on construction', () => {
      expect(mkdirSync).toHaveBeenCalledWith('/tmp/test-logs', { recursive: true });
    });

    it('generates log file with correct naming pattern', () => {
      // The logger should have created a file path like bot-YYYY-MM-DDTHH-MM-SS.log
      logger.info('test');
      const appendCall = vi.mocked(appendFileSync).mock.calls[0];
      const filePath = appendCall[0] as string;
      expect(filePath).toMatch(/\/tmp\/test-logs\/bot-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.log$/);
    });
  });

  describe('info', () => {
    it('writes to stdout', () => {
      logger.info('hello world');
      expect(stdoutSpy).toHaveBeenCalled();
      const output = stdoutSpy.mock.calls[0][0] as string;
      expect(output).toContain('hello world');
    });

    it('writes to log file', () => {
      logger.info('hello world');
      expect(appendFileSync).toHaveBeenCalled();
      const fileContent = vi.mocked(appendFileSync).mock.calls[0][1] as string;
      expect(fileContent).toContain('hello world');
    });
  });

  describe('success', () => {
    it('writes to stdout with green color', () => {
      logger.success('done');
      const output = stdoutSpy.mock.calls[0][0] as string;
      expect(output).toContain('done');
      // Should contain green ANSI code
      expect(output).toContain('\x1b[32m');
    });
  });

  describe('warn', () => {
    it('writes to stdout with yellow color', () => {
      logger.warn('careful');
      const output = stdoutSpy.mock.calls[0][0] as string;
      expect(output).toContain('careful');
      expect(output).toContain('\x1b[33m');
    });
  });

  describe('error', () => {
    it('writes to stdout with red color', () => {
      logger.error('failed');
      const output = stdoutSpy.mock.calls[0][0] as string;
      expect(output).toContain('failed');
      expect(output).toContain('\x1b[31m');
    });

    it('includes error object details when provided', () => {
      const err = new Error('something broke');
      logger.error('operation failed', err);
      const output = stdoutSpy.mock.calls[0][0] as string;
      expect(output).toContain('operation failed');
      expect(output).toContain('something broke');
    });

    it('handles non-Error objects', () => {
      logger.error('operation failed', 'string error');
      const output = stdoutSpy.mock.calls[0][0] as string;
      expect(output).toContain('string error');
    });
  });

  describe('debug', () => {
    it('writes to stdout with dim/gray color', () => {
      logger.debug('trace info');
      const output = stdoutSpy.mock.calls[0][0] as string;
      expect(output).toContain('trace info');
      expect(output).toContain('\x1b[2m');
    });
  });

  describe('group/step/groupEnd', () => {
    it('outputs group start with label and timestamp', () => {
      logger.group('STARTUP');
      const output = stdoutSpy.mock.calls[0][0] as string;
      expect(output).toContain('\u250c');
      expect(output).toContain('STARTUP');
      expect(output).toMatch(/\d{2}:\d{2}:\d{2}/);
    });

    it('outputs step with border and timestamp', () => {
      logger.step('loading config');
      const output = stdoutSpy.mock.calls[0][0] as string;
      expect(output).toContain('\u2502');
      expect(output).toContain('loading config');
      expect(output).toMatch(/\d{2}:\d{2}:\d{2}/);
    });

    it('outputs groupEnd with border and timestamp', () => {
      logger.groupEnd();
      const output = stdoutSpy.mock.calls[0][0] as string;
      expect(output).toContain('\u2514');
      expect(output).toContain('COMPLETE');
      expect(output).toMatch(/\d{2}:\d{2}:\d{2}/);
    });
  });

  describe('compact', () => {
    it('outputs tag and detail with dash prefix and timestamp', () => {
      logger.compact('MCP', 'loaded 5 tools');
      const output = stdoutSpy.mock.calls[0][0] as string;
      expect(output).toContain('\u2500');
      expect(output).toContain('MCP');
      expect(output).toContain('loaded 5 tools');
      expect(output).toMatch(/\d{2}:\d{2}:\d{2}/);
    });
  });

  describe('file output', () => {
    it('strips ANSI codes from file output', () => {
      logger.success('green text');
      const fileContent = vi.mocked(appendFileSync).mock.calls[0][1] as string;
      // File content should not contain ANSI escape codes
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequence stripping requires matching ESC character
      expect(fileContent).not.toMatch(/\x1b\[[0-9;]*m/);
      // But should still contain the text
      expect(fileContent).toContain('green text');
    });

    it('includes timestamp in output', () => {
      logger.info('timestamped');
      const output = stdoutSpy.mock.calls[0][0] as string;
      // Should contain a HH:MM:SS timestamp pattern
      expect(output).toMatch(/\d{2}:\d{2}:\d{2}/);
    });
  });
});
