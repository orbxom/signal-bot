import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage } from '../src/storage';

// Mock child_process.spawn to simulate Claude CLI
const mockSpawn = vi.fn();
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: (...args: unknown[]) => mockSpawn(...args) };
});

vi.mock('../src/logger', () => ({
  logger: { step: vi.fn(), info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { MemoryConsolidator } from '../src/memoryConsolidator';

function makeTempDb(): Storage {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consolidator-test-'));
  return new Storage(path.join(dir, 'test.db'));
}

function makeClaudeOutput(json: object): string {
  return JSON.stringify([
    { type: 'result', result: JSON.stringify(json), is_error: false, usage: { input_tokens: 10, output_tokens: 50 } },
  ]);
}

/** Create a fake child process that emits stdout data and exits with code 0 */
function fakeChild(stdout: string) {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end: vi.fn() };
  child.killed = false;
  child.kill = vi.fn();
  child.pid = Math.floor(Math.random() * 99999);

  process.nextTick(() => {
    child.stdout.emit('data', Buffer.from(stdout));
    child.emit('close', 0);
  });

  return child;
}

/** Create a fake child process that exits with an error code */
function fakeChildError(code = 1) {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end: vi.fn() };
  child.killed = false;
  child.kill = vi.fn();
  child.pid = Math.floor(Math.random() * 99999);

  process.nextTick(() => {
    child.emit('close', code);
  });

  return child;
}

describe('MemoryConsolidator', () => {
  let storage: Storage;
  let consolidator: MemoryConsolidator;

  beforeEach(() => {
    vi.clearAllMocks();
    storage = makeTempDb();
    consolidator = new MemoryConsolidator(storage, 'Australia/Sydney');
  });

  it('should not run if already ran today', async () => {
    storage.conn.db
      .prepare("INSERT INTO schema_meta (key, value) VALUES ('consolidation_last_run', ?)")
      .run(String(Date.now()));

    await consolidator.runIfDue();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('should store daily summary with __daily: prefix', async () => {
    storage.addMessage({
      groupId: 'g1',
      sender: 'alice',
      content: 'hello',
      timestamp: Date.now() - 1000,
      isBot: false,
    });

    mockSpawn.mockReturnValue(
      fakeChild(
        makeClaudeOutput({
          dossierUpdates: [],
          memoryUpdates: [],
          dailySummary: 'Alice said hello. Quiet day.',
        }),
      ),
    );

    await consolidator.consolidateGroup('g1');

    const memories = storage.memories.getByGroup('g1');
    const daily = memories.find(m => m.title.startsWith('__daily:'));
    expect(daily).toBeTruthy();
    expect(daily?.content).toBe('Alice said hello. Quiet day.');
  });

  it('should trim daily summaries older than 14 days', async () => {
    storage.memories.save('g1', '__daily:2026-03-01', 'text', { content: 'old summary' });
    storage.memories.save('g1', '__daily:2026-03-25', 'text', { content: 'recent summary' });

    consolidator.trimOldDailies('g1', 14);

    const allMemories = storage.memories.getByGroup('g1');
    const old = allMemories.find(m => m.title === '__daily:2026-03-01');
    const recent = allMemories.find(m => m.title === '__daily:2026-03-25');
    expect(old).toBeUndefined();
    expect(recent).toBeTruthy();
  });

  it('should handle JSON wrapped in markdown code fences', async () => {
    storage.addMessage({
      groupId: 'g1',
      sender: 'alice',
      content: 'I like painting',
      timestamp: Date.now() - 1000,
      isBot: false,
    });

    const fencedJson = '```json\n' + JSON.stringify({
      dossierUpdates: [{ personId: 'alice', displayName: 'Alice', notes: 'Likes painting' }],
      memoryUpdates: [],
      dailySummary: 'Alice mentioned painting.',
    }) + '\n```';

    mockSpawn.mockReturnValue(
      fakeChild(JSON.stringify([{ type: 'result', result: fencedJson, is_error: false, usage: {} }])),
    );

    await consolidator.consolidateGroup('g1');

    const dossier = storage.getDossier('g1', 'alice');
    expect(dossier).toBeTruthy();
    expect(dossier?.notes).toBe('Likes painting');
  });

  it('should handle spawn failure gracefully', async () => {
    storage.addMessage({
      groupId: 'g1',
      sender: 'alice',
      content: 'hello',
      timestamp: Date.now() - 1000,
      isBot: false,
    });

    mockSpawn.mockReturnValue(fakeChildError(1));
    await expect(consolidator.consolidateGroup('g1')).resolves.not.toThrow();
  });

  it('should apply dossier updates from Claude response', async () => {
    storage.addMessage({
      groupId: 'g1',
      sender: 'alice',
      content: 'I love hiking on weekends',
      timestamp: Date.now() - 1000,
      isBot: false,
    });

    mockSpawn.mockReturnValue(
      fakeChild(
        makeClaudeOutput({
          dossierUpdates: [{ personId: 'alice', displayName: 'Alice', notes: 'Enjoys hiking on weekends' }],
          memoryUpdates: [],
          dailySummary: 'Alice mentioned she likes hiking.',
        }),
      ),
    );

    await consolidator.consolidateGroup('g1');

    const dossier = storage.getDossier('g1', 'alice');
    expect(dossier).toBeTruthy();
    expect(dossier?.notes).toBe('Enjoys hiking on weekends');
  });

  it('should apply memory updates from Claude response', async () => {
    storage.addMessage({
      groupId: 'g1',
      sender: 'alice',
      content: 'Movie night is every Friday',
      timestamp: Date.now() - 1000,
      isBot: false,
    });

    mockSpawn.mockReturnValue(
      fakeChild(
        makeClaudeOutput({
          dossierUpdates: [],
          memoryUpdates: [{ action: 'upsert', title: 'movie-night', content: 'Movie night is every Friday' }],
          dailySummary: 'Group discussed movie night schedule.',
        }),
      ),
    );

    await consolidator.consolidateGroup('g1');

    const memories = storage.memories.getByGroup('g1');
    const memory = memories.find(m => m.title === 'movie-night');
    expect(memory).toBeTruthy();
    expect(memory?.content).toBe('Movie night is every Friday');
  });

  it('should handle memory delete updates', async () => {
    storage.memories.save('g1', 'old-topic', 'text', { content: 'old content' });

    storage.addMessage({
      groupId: 'g1',
      sender: 'alice',
      content: 'forget about old-topic',
      timestamp: Date.now() - 1000,
      isBot: false,
    });

    mockSpawn.mockReturnValue(
      fakeChild(
        makeClaudeOutput({
          dossierUpdates: [],
          memoryUpdates: [{ action: 'delete', title: 'old-topic' }],
          dailySummary: 'Alice asked to forget old-topic.',
        }),
      ),
    );

    await consolidator.consolidateGroup('g1');

    const memories = storage.memories.getByGroup('g1');
    const memory = memories.find(m => m.title === 'old-topic');
    expect(memory).toBeUndefined();
  });

  it('should skip groups with no messages in last 24h', async () => {
    await consolidator.consolidateGroup('g1');
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('should run consolidation for all groups when runIfDue triggers', async () => {
    storage.addMessage({
      groupId: 'g1',
      sender: 'alice',
      content: 'hello from g1',
      timestamp: Date.now() - 1000,
      isBot: false,
    });
    storage.addMessage({
      groupId: 'g2',
      sender: 'bob',
      content: 'hello from g2',
      timestamp: Date.now() - 1000,
      isBot: false,
    });

    const output = makeClaudeOutput({
      dossierUpdates: [],
      memoryUpdates: [],
      dailySummary: 'Quiet day.',
    });
    mockSpawn.mockImplementation(() => fakeChild(output));

    await consolidator.runIfDue();

    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });
});
