import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FactoryService } from '../../src/services/factoryService';

describe('FactoryService', () => {
  let factoryService: FactoryService;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-test-'));
  });

  afterEach(async () => {
    if (factoryService) {
      await factoryService.stop();
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty snapshot when no runs exist', () => {
    factoryService = new FactoryService(tmpDir);
    const snapshot = factoryService.getSnapshot();
    expect(snapshot).toEqual({});
  });

  it('does not throw when runsDir does not exist', () => {
    factoryService = new FactoryService('/nonexistent/path');
    expect(() => factoryService.start()).not.toThrow();
  });

  it('detects status.json and populates run', async () => {
    factoryService = new FactoryService(tmpDir);

    const runDir = path.join(tmpDir, 'issue-42');
    fs.mkdirSync(runDir);

    const statusData = {
      runId: 'issue-42',
      currentStage: 'build',
      stages: { plan: 'complete', build: 'in-progress' },
    };

    factoryService.start();

    // Wait for chokidar ready
    await new Promise<void>((resolve) => {
      factoryService.on('ready', resolve);
    });

    // Write status file
    fs.writeFileSync(path.join(runDir, 'status.json'), JSON.stringify(statusData));

    // Wait for file to be detected (chokidar awaitWriteFinish + debounce)
    await new Promise((r) => setTimeout(r, 600));

    const snapshot = factoryService.getSnapshot();
    expect(snapshot['issue-42']).toBeDefined();
    expect(snapshot['issue-42'].status.currentStage).toBe('build');
  });

  it('detects event.json and populates run', async () => {
    factoryService = new FactoryService(tmpDir);

    const runDir = path.join(tmpDir, 'issue-99');
    fs.mkdirSync(runDir);

    const eventData = {
      title: 'Fix the thing',
      issueNumber: 99,
      source: 'github',
    };

    factoryService.start();
    await new Promise<void>((resolve) => {
      factoryService.on('ready', resolve);
    });

    fs.writeFileSync(path.join(runDir, 'event.json'), JSON.stringify(eventData));

    await new Promise((r) => setTimeout(r, 600));

    const snapshot = factoryService.getSnapshot();
    expect(snapshot['issue-99']).toBeDefined();
    expect(snapshot['issue-99'].event.title).toBe('Fix the thing');
    expect(snapshot['issue-99'].event.issueNumber).toBe(99);
  });

  it('detects diary.md and populates run', async () => {
    factoryService = new FactoryService(tmpDir);

    const runDir = path.join(tmpDir, 'issue-10');
    fs.mkdirSync(runDir);

    factoryService.start();
    await new Promise<void>((resolve) => {
      factoryService.on('ready', resolve);
    });

    fs.writeFileSync(path.join(runDir, 'diary.md'), '# Day 1\nStarted work');

    await new Promise((r) => setTimeout(r, 600));

    const snapshot = factoryService.getSnapshot();
    expect(snapshot['issue-10']).toBeDefined();
    expect(snapshot['issue-10'].diary).toContain('Day 1');
  });

  it('emits update events when files change', async () => {
    factoryService = new FactoryService(tmpDir);

    const runDir = path.join(tmpDir, 'issue-7');
    fs.mkdirSync(runDir);

    factoryService.start();
    await new Promise<void>((resolve) => {
      factoryService.on('ready', resolve);
    });

    const updatePromise = new Promise<any>((resolve) => {
      factoryService.on('update', resolve);
    });

    fs.writeFileSync(
      path.join(runDir, 'status.json'),
      JSON.stringify({ runId: 'issue-7', currentStage: 'plan', stages: {} }),
    );

    const update = await updatePromise;
    expect(update.type).toBe('update');
    expect(update.runId).toBe('issue-7');
    expect(update.file).toBe('status');
  });

  it('ignores non-recognized files', async () => {
    factoryService = new FactoryService(tmpDir);

    const runDir = path.join(tmpDir, 'issue-5');
    fs.mkdirSync(runDir);

    factoryService.start();
    await new Promise<void>((resolve) => {
      factoryService.on('ready', resolve);
    });

    fs.writeFileSync(path.join(runDir, 'random.txt'), 'not relevant');

    await new Promise((r) => setTimeout(r, 600));

    const snapshot = factoryService.getSnapshot();
    // Run might be created but won't have meaningful data beyond defaults
    if (snapshot['issue-5']) {
      expect(snapshot['issue-5'].status.currentStage).toBe('unknown');
    }
  });

  it('stop closes the watcher', async () => {
    factoryService = new FactoryService(tmpDir);
    factoryService.start();
    await new Promise<void>((resolve) => {
      factoryService.on('ready', resolve);
    });

    await factoryService.stop();

    // After stop, writing files should not trigger updates
    const runDir = path.join(tmpDir, 'issue-post-stop');
    fs.mkdirSync(runDir);
    fs.writeFileSync(
      path.join(runDir, 'status.json'),
      JSON.stringify({ runId: 'issue-post-stop', currentStage: 'plan', stages: {} }),
    );

    await new Promise((r) => setTimeout(r, 600));

    const snapshot = factoryService.getSnapshot();
    expect(snapshot['issue-post-stop']).toBeUndefined();
  });
});
