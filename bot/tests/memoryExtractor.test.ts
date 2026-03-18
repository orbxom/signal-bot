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

import { MemoryExtractor } from '../src/memoryExtractor';

function makeTempDb(): Storage {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'extractor-test-'));
  return new Storage(path.join(dir, 'test.db'));
}

function makeClaudeOutput(json: object): string {
  return JSON.stringify([
    { type: 'result', result: JSON.stringify(json), is_error: false, usage: { input_tokens: 10, output_tokens: 50 } },
  ]);
}

describe('MemoryExtractor', () => {
  let storage: Storage;
  let extractor: MemoryExtractor;

  beforeEach(() => {
    vi.clearAllMocks();
    storage = makeTempDb();
    extractor = new MemoryExtractor(storage);
  });

  describe('parseAndApply', () => {
    it('should upsert a new dossier from extraction result', async () => {
      mockSpawnPromise.mockResolvedValue({
        stdout: makeClaudeOutput({
          dossierUpdates: [{ action: 'update', personId: 'user-1', displayName: 'Alice', notes: 'Likes cats' }],
          memoryUpdates: [],
        }),
      });

      await extractor.extract('group-1');

      const dossier = storage.dossiers.get('group-1', 'user-1');
      expect(dossier).not.toBeNull();
      expect(dossier?.displayName).toBe('Alice');
      expect(dossier?.notes).toBe('Likes cats');
    });

    it('should add a new memory from extraction result', async () => {
      mockSpawnPromise.mockResolvedValue({
        stdout: makeClaudeOutput({
          dossierUpdates: [],
          memoryUpdates: [{ action: 'add', topic: 'pizza night', content: 'Every Friday at 7pm' }],
        }),
      });

      await extractor.extract('group-1');

      const memory = storage.memories.get('group-1', 'pizza night');
      expect(memory).not.toBeNull();
      expect(memory?.content).toBe('Every Friday at 7pm');
    });

    it('should delete a memory when action is delete', async () => {
      storage.memories.upsert('group-1', 'old-topic', 'stale info');

      mockSpawnPromise.mockResolvedValue({
        stdout: makeClaudeOutput({
          dossierUpdates: [],
          memoryUpdates: [{ action: 'delete', topic: 'old-topic' }],
        }),
      });

      await extractor.extract('group-1');

      const memory = storage.memories.get('group-1', 'old-topic');
      expect(memory).toBeNull();
    });

    it('should handle empty extraction result gracefully', async () => {
      mockSpawnPromise.mockResolvedValue({
        stdout: makeClaudeOutput({ dossierUpdates: [], memoryUpdates: [] }),
      });

      await expect(extractor.extract('group-1')).resolves.not.toThrow();
    });

    it('should handle malformed JSON gracefully', async () => {
      mockSpawnPromise.mockResolvedValue({
        stdout: JSON.stringify([{ type: 'result', result: 'not valid json {{{', is_error: false, usage: {} }]),
      });

      await expect(extractor.extract('group-1')).resolves.not.toThrow();
    });

    it('should handle spawn failure gracefully', async () => {
      mockSpawnPromise.mockRejectedValue(new Error('spawn failed'));

      await expect(extractor.extract('group-1')).resolves.not.toThrow();
    });
  });

  describe('scheduleExtraction', () => {
    it('should debounce multiple calls within 5s window', async () => {
      vi.useFakeTimers();

      mockSpawnPromise.mockResolvedValue({
        stdout: makeClaudeOutput({ dossierUpdates: [], memoryUpdates: [] }),
      });

      extractor.scheduleExtraction('group-1');
      extractor.scheduleExtraction('group-1');
      extractor.scheduleExtraction('group-1');

      // Not called yet (debounced)
      expect(mockSpawnPromise).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5000);

      // Should only have been called once despite 3 schedules
      expect(mockSpawnPromise).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
      extractor.clearTimers();
    });

    it('should handle different groups independently', async () => {
      vi.useFakeTimers();

      mockSpawnPromise.mockResolvedValue({
        stdout: makeClaudeOutput({ dossierUpdates: [], memoryUpdates: [] }),
      });

      extractor.scheduleExtraction('group-1');
      extractor.scheduleExtraction('group-2');

      await vi.advanceTimersByTimeAsync(5000);

      // Should be called once per group
      expect(mockSpawnPromise).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
      extractor.clearTimers();
    });
  });

  describe('clearTimers', () => {
    it('should cancel pending extractions', async () => {
      vi.useFakeTimers();

      mockSpawnPromise.mockResolvedValue({
        stdout: makeClaudeOutput({ dossierUpdates: [], memoryUpdates: [] }),
      });

      extractor.scheduleExtraction('group-1');
      extractor.clearTimers();

      await vi.advanceTimersByTimeAsync(10000);

      expect(mockSpawnPromise).not.toHaveBeenCalled();

      vi.useRealTimers();
    });
  });

  describe('concurrency', () => {
    it('should not run more than 1 extraction at a time', async () => {
      let concurrentCount = 0;
      let maxConcurrent = 0;

      mockSpawnPromise.mockImplementation(async () => {
        concurrentCount++;
        maxConcurrent = Math.max(maxConcurrent, concurrentCount);
        await new Promise(resolve => setTimeout(resolve, 50));
        concurrentCount--;
        return { stdout: makeClaudeOutput({ dossierUpdates: [], memoryUpdates: [] }) };
      });

      // Start two extractions concurrently
      const p1 = extractor.extract('group-1');
      const p2 = extractor.extract('group-2');

      await Promise.all([p1, p2]);

      expect(maxConcurrent).toBe(1);
    });
  });
});
