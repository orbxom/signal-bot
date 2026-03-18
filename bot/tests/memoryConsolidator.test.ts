import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage } from '../src/storage';

const { mockSpawnPromise } = vi.hoisted(() => {
  const mockSpawnPromise = vi.fn();
  return { mockSpawnPromise };
});

vi.mock('../src/claudeClient', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/claudeClient')>();
  return { ...actual, spawnPromise: mockSpawnPromise };
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
    expect(mockSpawnPromise).not.toHaveBeenCalled();
  });

  it('should store daily summary with __daily: prefix', async () => {
    storage.addMessage({
      groupId: 'g1',
      sender: 'alice',
      content: 'hello',
      timestamp: Date.now() - 1000,
      isBot: false,
    });

    mockSpawnPromise.mockResolvedValue({
      stdout: makeClaudeOutput({
        dossierUpdates: [],
        memoryUpdates: [],
        dailySummary: 'Alice said hello. Quiet day.',
      }),
    });

    await consolidator.consolidateGroup('g1');

    const memories = storage.memories.getByGroup('g1');
    const daily = memories.find(m => m.topic.startsWith('__daily:'));
    expect(daily).toBeTruthy();
    expect(daily?.content).toBe('Alice said hello. Quiet day.');
  });

  it('should trim daily summaries older than 14 days', async () => {
    storage.memories.upsert('g1', '__daily:2026-03-01', 'old summary');
    storage.memories.upsert('g1', '__daily:2026-03-17', 'recent summary');

    consolidator.trimOldDailies('g1', 14);

    const old = storage.memories.get('g1', '__daily:2026-03-01');
    const recent = storage.memories.get('g1', '__daily:2026-03-17');
    expect(old).toBeNull();
    expect(recent).not.toBeNull();
  });

  it('should handle spawn failure gracefully', async () => {
    storage.addMessage({
      groupId: 'g1',
      sender: 'alice',
      content: 'hello',
      timestamp: Date.now() - 1000,
      isBot: false,
    });

    mockSpawnPromise.mockRejectedValue(new Error('spawn failed'));
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

    mockSpawnPromise.mockResolvedValue({
      stdout: makeClaudeOutput({
        dossierUpdates: [{ personId: 'alice', displayName: 'Alice', notes: 'Enjoys hiking on weekends' }],
        memoryUpdates: [],
        dailySummary: 'Alice mentioned she likes hiking.',
      }),
    });

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

    mockSpawnPromise.mockResolvedValue({
      stdout: makeClaudeOutput({
        dossierUpdates: [],
        memoryUpdates: [{ action: 'upsert', topic: 'movie-night', content: 'Movie night is every Friday' }],
        dailySummary: 'Group discussed movie night schedule.',
      }),
    });

    await consolidator.consolidateGroup('g1');

    const memory = storage.getMemory('g1', 'movie-night');
    expect(memory).toBeTruthy();
    expect(memory?.content).toBe('Movie night is every Friday');
  });

  it('should handle memory delete updates', async () => {
    storage.upsertMemory('g1', 'old-topic', 'old content');

    storage.addMessage({
      groupId: 'g1',
      sender: 'alice',
      content: 'forget about old-topic',
      timestamp: Date.now() - 1000,
      isBot: false,
    });

    mockSpawnPromise.mockResolvedValue({
      stdout: makeClaudeOutput({
        dossierUpdates: [],
        memoryUpdates: [{ action: 'delete', topic: 'old-topic' }],
        dailySummary: 'Alice asked to forget old-topic.',
      }),
    });

    await consolidator.consolidateGroup('g1');

    const memory = storage.getMemory('g1', 'old-topic');
    expect(memory).toBeNull();
  });

  it('should skip groups with no messages in last 24h', async () => {
    // No messages added
    await consolidator.consolidateGroup('g1');
    expect(mockSpawnPromise).not.toHaveBeenCalled();
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

    mockSpawnPromise.mockResolvedValue({
      stdout: makeClaudeOutput({
        dossierUpdates: [],
        memoryUpdates: [],
        dailySummary: 'Quiet day.',
      }),
    });

    await consolidator.runIfDue();

    // Should have been called for each group
    expect(mockSpawnPromise).toHaveBeenCalledTimes(2);
  });
});
