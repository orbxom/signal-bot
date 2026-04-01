import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '../logger';

// Suppress stdout output during tests
vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

describe('Logger level tags', () => {
  let logDir: string;
  let logger: Logger;

  beforeEach(() => {
    logDir = mkdtempSync(path.join(tmpdir(), 'logger-test-'));
    logger = new Logger({ logDir });
  });

  afterEach(() => {
    logger.close();
    rmSync(logDir, { recursive: true, force: true });
  });

  function getLogContent(): string {
    const files = readdirSync(logDir).filter(f => f.endsWith('.log'));
    expect(files.length).toBe(1);
    return readFileSync(path.join(logDir, files[0]), 'utf-8');
  }

  // Helper to wait for async stream writes to flush
  async function flush(): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  it('info() includes [INFO] tag in log file', async () => {
    logger.info('test message');
    await flush();
    const content = getLogContent();
    expect(content).toMatch(/\d{2}:\d{2}:\d{2} \[INFO\] test message/);
  });

  it('warn() includes [WARN] tag in log file', async () => {
    logger.warn('warning message');
    await flush();
    const content = getLogContent();
    expect(content).toMatch(/\d{2}:\d{2}:\d{2} \[WARN\] warning message/);
  });

  it('error() includes [ERROR] tag in log file', async () => {
    logger.error('error message');
    await flush();
    const content = getLogContent();
    expect(content).toMatch(/\d{2}:\d{2}:\d{2} \[ERROR\] error message/);
  });

  it('error() with Error object includes [ERROR] tag', async () => {
    logger.error('something failed', new Error('details'));
    await flush();
    const content = getLogContent();
    expect(content).toMatch(/\d{2}:\d{2}:\d{2} \[ERROR\] something failed \(details\)/);
  });

  it('debug() includes [DEBUG] tag in log file', async () => {
    logger.debug('debug info');
    await flush();
    const content = getLogContent();
    expect(content).toMatch(/\d{2}:\d{2}:\d{2} \[DEBUG\] debug info/);
  });

  it('success() includes [SUCCESS] tag in log file', async () => {
    logger.success('it worked');
    await flush();
    const content = getLogContent();
    expect(content).toMatch(/\d{2}:\d{2}:\d{2} \[SUCCESS\] it worked/);
  });

  it('group() includes [INFO] tag in log file', async () => {
    logger.group('group label');
    await flush();
    const content = getLogContent();
    expect(content).toMatch(/\d{2}:\d{2}:\d{2} \[INFO\]/);
  });

  it('step() includes [INFO] tag in log file', async () => {
    logger.step('step message');
    await flush();
    const content = getLogContent();
    expect(content).toMatch(/\d{2}:\d{2}:\d{2} \[INFO\]/);
  });

  it('compact() includes [INFO] tag in log file', async () => {
    logger.compact('TAG', 'some detail');
    await flush();
    const content = getLogContent();
    expect(content).toMatch(/\d{2}:\d{2}:\d{2} \[INFO\]/);
  });

  it('groupEnd() includes [INFO] tag in log file', async () => {
    logger.groupEnd();
    await flush();
    const content = getLogContent();
    expect(content).toMatch(/\d{2}:\d{2}:\d{2} \[INFO\]/);
  });
});
