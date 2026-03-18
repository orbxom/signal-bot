import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoist the mock stream so it's available when the mock factory runs at import time
const mockStream = vi.hoisted(() => ({
  write: vi.fn(),
  end: vi.fn(),
}));

// Mock node:fs before importing Logger
vi.mock('node:fs', () => ({
  mkdirSync: vi.fn(),
  createWriteStream: vi.fn(() => mockStream),
  readdirSync: vi.fn(() => []),
  unlinkSync: vi.fn(),
  existsSync: vi.fn(() => true),
}));

import { createWriteStream, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { Logger } from '../src/logger';

describe('Logger', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let logger: Logger;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mockStream mocks too
    mockStream.write.mockClear();
    mockStream.end.mockClear();
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
      // The logger should have created a WriteStream with a correct path
      const streamCall = vi.mocked(createWriteStream).mock.calls[0];
      const filePath = streamCall[0] as string;
      expect(filePath).toMatch(/\/tmp\/test-logs\/bot-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.log$/);
    });

    it('creates a WriteStream in append mode', () => {
      expect(createWriteStream).toHaveBeenCalledTimes(1);
      const streamCall = vi.mocked(createWriteStream).mock.calls[0];
      expect(streamCall[1]).toEqual({ flags: 'a' });
    });

    it('cleans old log files beyond keepCount', () => {
      vi.clearAllMocks();
      mockStream.write.mockClear();
      mockStream.end.mockClear();
      vi.mocked(readdirSync).mockReturnValue([
        'bot-2026-01-01T00-00-00.log' as unknown as import('node:fs').Dirent,
        'bot-2026-01-02T00-00-00.log' as unknown as import('node:fs').Dirent,
        'bot-2026-01-03T00-00-00.log' as unknown as import('node:fs').Dirent,
      ]);
      new Logger({ logDir: '/tmp/test-logs', maxLogFiles: 2 });
      // Should delete the oldest (first alphabetically after reverse-sort, beyond keep count)
      expect(unlinkSync).toHaveBeenCalledTimes(1);
      expect(unlinkSync).toHaveBeenCalledWith('/tmp/test-logs/bot-2026-01-01T00-00-00.log');
    });

    it('does not delete when fewer than keepCount log files exist', () => {
      vi.clearAllMocks();
      mockStream.write.mockClear();
      mockStream.end.mockClear();
      vi.mocked(readdirSync).mockReturnValue([
        'bot-2026-01-01T00-00-00.log' as unknown as import('node:fs').Dirent,
        'bot-2026-01-02T00-00-00.log' as unknown as import('node:fs').Dirent,
      ]);
      new Logger({ logDir: '/tmp/test-logs', maxLogFiles: 10 });
      expect(unlinkSync).not.toHaveBeenCalled();
    });

    it('defaults maxLogFiles to 10', () => {
      vi.clearAllMocks();
      mockStream.write.mockClear();
      mockStream.end.mockClear();
      // Create 12 log files
      const files = Array.from({ length: 12 }, (_, i) => {
        const day = String(i + 1).padStart(2, '0');
        return `bot-2026-01-${day}T00-00-00.log` as unknown as import('node:fs').Dirent;
      });
      vi.mocked(readdirSync).mockReturnValue(files);
      new Logger({ logDir: '/tmp/test-logs' });
      // Should delete the 2 oldest (12 - 10 = 2)
      expect(unlinkSync).toHaveBeenCalledTimes(2);
    });

    it('only considers bot-*.log files for rotation', () => {
      vi.clearAllMocks();
      mockStream.write.mockClear();
      mockStream.end.mockClear();
      vi.mocked(readdirSync).mockReturnValue([
        'bot-2026-01-01T00-00-00.log' as unknown as import('node:fs').Dirent,
        'other-file.txt' as unknown as import('node:fs').Dirent,
        'bot-2026-01-02T00-00-00.log' as unknown as import('node:fs').Dirent,
        'readme.md' as unknown as import('node:fs').Dirent,
      ]);
      new Logger({ logDir: '/tmp/test-logs', maxLogFiles: 2 });
      // Only 2 bot-*.log files, keepCount is 2, so nothing deleted
      expect(unlinkSync).not.toHaveBeenCalled();
    });
  });

  describe('info', () => {
    it('writes to stdout', () => {
      logger.info('hello world');
      expect(stdoutSpy).toHaveBeenCalled();
      const output = stdoutSpy.mock.calls[0][0] as string;
      expect(output).toContain('hello world');
    });

    it('writes to log file via stream', () => {
      logger.info('hello world');
      expect(mockStream.write).toHaveBeenCalled();
      const fileContent = mockStream.write.mock.calls[0][0] as string;
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
      const fileContent = mockStream.write.mock.calls[0][0] as string;
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

  describe('close', () => {
    it('ends the write stream', () => {
      logger.close();
      expect(mockStream.end).toHaveBeenCalledTimes(1);
    });
  });
});
