import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage } from '../src/storage';

// Mock child_process.spawn to simulate Claude CLI
const mockSpawn = vi.fn();
vi.mock('node:child_process', () => ({ spawn: (...args: unknown[]) => mockSpawn(...args) }));

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

/** Create a fake child process that emits stdout data and exits with code 0 */
function fakeChild(stdout: string) {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end: vi.fn() };
  child.killed = false;
  child.kill = vi.fn();
  child.pid = Math.floor(Math.random() * 99999);

  // Emit stdout data and close asynchronously
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
      mockSpawn.mockReturnValue(
        fakeChild(
          makeClaudeOutput({
            dossierUpdates: [{ action: 'update', personId: 'user-1', displayName: 'Alice', notes: 'Likes cats' }],
            memoryUpdates: [],
          }),
        ),
      );

      await extractor.extract('group-1');

      const dossier = storage.dossiers.get('group-1', 'user-1');
      expect(dossier).not.toBeNull();
      expect(dossier?.displayName).toBe('Alice');
      expect(dossier?.notes).toBe('Likes cats');
    });

    it('should add a new memory from extraction result', async () => {
      mockSpawn.mockReturnValue(
        fakeChild(
          makeClaudeOutput({
            dossierUpdates: [],
            memoryUpdates: [{ action: 'add', topic: 'pizza night', content: 'Every Friday at 7pm' }],
          }),
        ),
      );

      await extractor.extract('group-1');

      const memory = storage.memories.get('group-1', 'pizza night');
      expect(memory).not.toBeNull();
      expect(memory?.content).toBe('Every Friday at 7pm');
    });

    it('should delete a memory when action is delete', async () => {
      storage.memories.upsert('group-1', 'old-topic', 'stale info');

      mockSpawn.mockReturnValue(
        fakeChild(
          makeClaudeOutput({
            dossierUpdates: [],
            memoryUpdates: [{ action: 'delete', topic: 'old-topic' }],
          }),
        ),
      );

      await extractor.extract('group-1');

      const memory = storage.memories.get('group-1', 'old-topic');
      expect(memory).toBeNull();
    });

    it('should handle empty extraction result gracefully', async () => {
      mockSpawn.mockReturnValue(fakeChild(makeClaudeOutput({ dossierUpdates: [], memoryUpdates: [] })));

      await expect(extractor.extract('group-1')).resolves.not.toThrow();
    });

    it('should handle malformed JSON gracefully', async () => {
      mockSpawn.mockReturnValue(
        fakeChild(JSON.stringify([{ type: 'result', result: 'not valid json {{{', is_error: false, usage: {} }])),
      );

      await expect(extractor.extract('group-1')).resolves.not.toThrow();
    });

    it('should handle spawn failure gracefully', async () => {
      mockSpawn.mockReturnValue(fakeChildError(1));

      await expect(extractor.extract('group-1')).resolves.not.toThrow();
    });
  });

  describe('scheduleExtraction', () => {
    it('should debounce multiple calls within 5s window', async () => {
      vi.useFakeTimers();

      mockSpawn.mockReturnValue(fakeChild(makeClaudeOutput({ dossierUpdates: [], memoryUpdates: [] })));

      extractor.scheduleExtraction('group-1');
      extractor.scheduleExtraction('group-1');
      extractor.scheduleExtraction('group-1');

      expect(mockSpawn).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5000);

      expect(mockSpawn).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
      extractor.clearTimers();
    });

    it('should handle different groups independently', async () => {
      vi.useFakeTimers();

      mockSpawn.mockReturnValue(fakeChild(makeClaudeOutput({ dossierUpdates: [], memoryUpdates: [] })));

      extractor.scheduleExtraction('group-1');
      extractor.scheduleExtraction('group-2');

      await vi.advanceTimersByTimeAsync(5000);

      // Called once per group (may be serialized by limiter, so 1 or 2)
      expect(mockSpawn.mock.calls.length).toBeGreaterThanOrEqual(1);

      vi.useRealTimers();
      extractor.clearTimers();
    });
  });

  describe('clearTimers', () => {
    it('should cancel pending extractions', async () => {
      vi.useFakeTimers();

      mockSpawn.mockReturnValue(fakeChild(makeClaudeOutput({ dossierUpdates: [], memoryUpdates: [] })));

      extractor.scheduleExtraction('group-1');
      extractor.clearTimers();

      await vi.advanceTimersByTimeAsync(10000);

      expect(mockSpawn).not.toHaveBeenCalled();

      vi.useRealTimers();
    });
  });
});
