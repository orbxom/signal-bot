import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getRecentErrors, searchBotLogs } from '../botLogs';

describe('getRecentErrors', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'botlogs-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function writeLogFile(name: string, lines: string[]): void {
    fs.writeFileSync(path.join(tempDir, name), lines.join('\n') + '\n');
  }

  it('should filter ERROR and WARN lines from log files', () => {
    writeLogFile('bot-2026-04-01.log', [
      '10:00:00 [INFO] Bot started',
      '10:00:01 [ERROR] Connection failed: timeout',
      '10:00:02 [INFO] Retrying...',
      '10:00:03 [WARN] High memory usage',
      '10:00:04 [INFO] Connected',
    ]);

    const result = getRecentErrors(tempDir, 50);
    expect(result).toContain('[ERROR] Connection failed: timeout');
    expect(result).toContain('[WARN] High memory usage');
    expect(result).not.toContain('[INFO] Bot started');
    expect(result).not.toContain('[INFO] Retrying...');
    expect(result).not.toContain('[INFO] Connected');
  });

  it('should read multiple files with most recent first', () => {
    writeLogFile('bot-2026-03-30.log', [
      '10:00:00 [ERROR] Old error from March 30',
    ]);
    writeLogFile('bot-2026-04-01.log', [
      '10:00:00 [ERROR] Recent error from April 1',
    ]);
    writeLogFile('bot-2026-03-31.log', [
      '10:00:00 [ERROR] Middle error from March 31',
    ]);

    const result = getRecentErrors(tempDir, 50);
    const april1Pos = result.indexOf('Recent error from April 1');
    const march31Pos = result.indexOf('Middle error from March 31');
    const march30Pos = result.indexOf('Old error from March 30');

    expect(april1Pos).toBeGreaterThan(-1);
    expect(march31Pos).toBeGreaterThan(-1);
    expect(march30Pos).toBeGreaterThan(-1);
    // Most recent file should appear first
    expect(april1Pos).toBeLessThan(march31Pos);
    expect(march31Pos).toBeLessThan(march30Pos);
  });

  it('should respect line limit', () => {
    writeLogFile('bot-2026-04-01.log', [
      '10:00:00 [ERROR] Error 1',
      '10:00:01 [ERROR] Error 2',
      '10:00:02 [ERROR] Error 3',
      '10:00:03 [WARN] Warn 1',
      '10:00:04 [WARN] Warn 2',
    ]);

    const result = getRecentErrors(tempDir, 3);
    // Should only have 3 matching lines (plus header)
    const matchingLines = result
      .split('\n')
      .filter(l => l.includes('[ERROR]') || l.includes('[WARN]'));
    expect(matchingLines).toHaveLength(3);
  });

  it('should return message when no errors found', () => {
    writeLogFile('bot-2026-04-01.log', [
      '10:00:00 [INFO] Everything is fine',
      '10:00:01 [INFO] Still fine',
    ]);

    const result = getRecentErrors(tempDir, 50);
    expect(result).toBe('No errors or warnings found in recent log files.');
  });

  it('should return message when no log files exist', () => {
    const result = getRecentErrors(tempDir, 50);
    expect(result).toBe('No log files found in logs directory.');
  });

  it('should only read bot-*.log files', () => {
    writeLogFile('bot-2026-04-01.log', [
      '10:00:00 [ERROR] Real bot error',
    ]);
    writeLogFile('other-2026-04-01.log', [
      '10:00:00 [ERROR] Not a bot log',
    ]);
    writeLogFile('bot-2026-04-01.txt', [
      '10:00:00 [ERROR] Wrong extension',
    ]);

    const result = getRecentErrors(tempDir, 50);
    expect(result).toContain('Real bot error');
    expect(result).not.toContain('Not a bot log');
    expect(result).not.toContain('Wrong extension');
  });

  it('should include file headers in output', () => {
    writeLogFile('bot-2026-04-01.log', [
      '10:00:00 [ERROR] Some error',
    ]);

    const result = getRecentErrors(tempDir, 50);
    expect(result).toContain('--- bot-2026-04-01.log ---');
  });

  it('should limit to 3 most recent log files', () => {
    writeLogFile('bot-2026-03-28.log', ['10:00:00 [ERROR] Error from 28th']);
    writeLogFile('bot-2026-03-29.log', ['10:00:00 [ERROR] Error from 29th']);
    writeLogFile('bot-2026-03-30.log', ['10:00:00 [ERROR] Error from 30th']);
    writeLogFile('bot-2026-03-31.log', ['10:00:00 [ERROR] Error from 31st']);

    const result = getRecentErrors(tempDir, 50);
    expect(result).toContain('Error from 31st');
    expect(result).toContain('Error from 30th');
    expect(result).toContain('Error from 29th');
    expect(result).not.toContain('Error from 28th');
  });
});

describe('searchBotLogs', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'botlogs-search-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function writeLogFile(name: string, lines: string[]): void {
    fs.writeFileSync(path.join(tempDir, name), lines.join('\n') + '\n');
  }

  it('should find matching lines with context lines', () => {
    writeLogFile('bot-2026-04-01.log', [
      '10:00:00 [INFO] Starting up',
      '10:00:01 [ERROR] Connection failed',
      '10:00:02 [INFO] Retrying',
    ]);

    const result = searchBotLogs(tempDir, 'Connection failed', 1, 30);
    expect(result).toContain('--- bot-2026-04-01.log ---');
    expect(result).toContain('> 10:00:01 [ERROR] Connection failed');
    expect(result).toContain('  10:00:00 [INFO] Starting up');
    expect(result).toContain('  10:00:02 [INFO] Retrying');
  });

  it('should search across multiple log files most recent first', () => {
    writeLogFile('bot-2026-03-31.log', [
      '10:00:00 [ERROR] Old timeout error',
    ]);
    writeLogFile('bot-2026-04-01.log', [
      '10:00:00 [ERROR] Recent timeout error',
    ]);

    const result = searchBotLogs(tempDir, 'timeout', 0, 30);
    const recentPos = result.indexOf('Recent timeout');
    const oldPos = result.indexOf('Old timeout');
    expect(recentPos).toBeGreaterThan(-1);
    expect(oldPos).toBeGreaterThan(-1);
    expect(recentPos).toBeLessThan(oldPos);
  });

  it('should respect line limit', () => {
    writeLogFile('bot-2026-04-01.log', [
      '10:00:00 [ERROR] Error one',
      '10:00:01 [ERROR] Error two',
      '10:00:02 [ERROR] Error three',
      '10:00:03 [ERROR] Error four',
      '10:00:04 [ERROR] Error five',
    ]);

    const result = searchBotLogs(tempDir, 'Error', 0, 3);
    const matchLines = result.split('\n').filter(l => l.startsWith('> '));
    expect(matchLines).toHaveLength(3);
  });

  it('should return message when no matches found', () => {
    writeLogFile('bot-2026-04-01.log', [
      '10:00:00 [INFO] All good',
    ]);

    const result = searchBotLogs(tempDir, 'CATASTROPHE', 0, 30);
    expect(result).toContain('No matches found');
  });

  it('should handle case-insensitive search', () => {
    writeLogFile('bot-2026-04-01.log', [
      '10:00:00 [ERROR] Connection TIMEOUT occurred',
    ]);

    const result = searchBotLogs(tempDir, 'connection timeout', 0, 30);
    expect(result).toContain('> 10:00:00 [ERROR] Connection TIMEOUT occurred');
  });

  it('should return error message for invalid regex pattern', () => {
    writeLogFile('bot-2026-04-01.log', [
      '10:00:00 [INFO] Some line',
    ]);

    const result = searchBotLogs(tempDir, '[invalid', 0, 30);
    expect(result).toContain('Invalid search pattern');
    expect(result).toContain('[invalid');
  });
});
