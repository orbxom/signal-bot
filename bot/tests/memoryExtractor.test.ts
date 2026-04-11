import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractResultText, spawnCollect } from '../src/claudeClient';
import { MemoryExtractor } from '../src/memoryExtractor';

vi.mock('../src/claudeClient', () => ({
  spawnCollect: vi.fn(),
  extractResultText: vi.fn(),
}));

vi.mock('../src/logger', () => ({
  logger: { step: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockSpawn = vi.mocked(spawnCollect);
const mockExtract = vi.mocked(extractResultText);

describe('MemoryExtractor', () => {
  let extractor: MemoryExtractor;

  beforeEach(() => {
    extractor = new MemoryExtractor('/tmp/test.db');
  });

  afterEach(() => {
    extractor.clearTimers();
    extractor.killAll();
    vi.clearAllMocks();
  });

  describe('readMemories', () => {
    it('returns summary text when haiku finds relevant memories', async () => {
      mockSpawn.mockResolvedValue('{"type":"result","result":"Dad likes pizza"}');
      mockExtract.mockReturnValue('Dad likes pizza');

      const result = await extractor.readMemories('group1', 'what does dad like?');

      expect(result).toBe('Dad likes pizza');
      expect(mockSpawn).toHaveBeenCalledOnce();

      const args = mockSpawn.mock.calls[0][1];
      expect(args).toContain('-p');
      expect(args).toContain('--model');
      expect(args).toContain('claude-haiku-4-5-20251001');
      expect(args).toContain('Bash');
    });

    it('returns null when haiku says no relevant memories', async () => {
      mockSpawn.mockResolvedValue('{"type":"result","result":"No relevant memories found."}');
      mockExtract.mockReturnValue('No relevant memories found.');

      const result = await extractor.readMemories('group1', 'random message');

      expect(result).toBeNull();
    });

    it('returns null when extractResultText returns null', async () => {
      mockSpawn.mockResolvedValue('{}');
      mockExtract.mockReturnValue(null);

      const result = await extractor.readMemories('group1', 'hello');

      expect(result).toBeNull();
    });

    it('returns null on spawn error', async () => {
      mockSpawn.mockRejectedValue(new Error('timeout'));

      const result = await extractor.readMemories('group1', 'hello');

      expect(result).toBeNull();
    });

    it('passes groupId and message into the prompt', async () => {
      mockSpawn.mockResolvedValue('');
      mockExtract.mockReturnValue(null);

      await extractor.readMemories('abc-group', 'find birthday info');

      const prompt = mockSpawn.mock.calls[0][1][1];
      expect(prompt).toContain('abc-group');
      expect(prompt).toContain('find birthday info');
    });

    it('passes dbPath and timeout in spawn options', async () => {
      mockSpawn.mockResolvedValue('');
      mockExtract.mockReturnValue(null);

      await extractor.readMemories('g1', 'msg');

      const opts = mockSpawn.mock.calls[0][2];
      expect(opts.timeout).toBe(30_000);
      expect(opts.env).toMatchObject({ DB_PATH: '/tmp/test.db' });
    });
  });

  describe('writeMemories', () => {
    it('spawns haiku with conversation in prompt', async () => {
      mockSpawn.mockResolvedValue('{"type":"result","result":"saved 2 memories"}');
      mockExtract.mockReturnValue('saved 2 memories');

      await extractor.writeMemories('group1', 'User: hello\nBot: hi there');

      expect(mockSpawn).toHaveBeenCalledOnce();
      const prompt = mockSpawn.mock.calls[0][1][1];
      expect(prompt).toContain('User: hello\nBot: hi there');
      expect(prompt).toContain('group1');
    });

    it('includes savedTitles dedup warning when provided', async () => {
      mockSpawn.mockResolvedValue('{"type":"result","result":""}');
      mockExtract.mockReturnValue(null);

      await extractor.writeMemories('group1', 'User: hi\nBot: hey', ["Dad's birthday", 'Likes pizza']);

      const prompt = mockSpawn.mock.calls[0][1][1];
      expect(prompt).toContain('already saved these memories');
      expect(prompt).toContain("Dad's birthday");
      expect(prompt).toContain('Likes pizza');
    });

    it('omits savedTitles section when list is empty', async () => {
      mockSpawn.mockResolvedValue('{"type":"result","result":""}');
      mockExtract.mockReturnValue(null);

      await extractor.writeMemories('group1', 'User: hi\nBot: hey', []);

      const prompt = mockSpawn.mock.calls[0][1][1];
      expect(prompt).not.toContain('already saved these memories');
    });

    it('omits savedTitles section when undefined', async () => {
      mockSpawn.mockResolvedValue('{"type":"result","result":""}');
      mockExtract.mockReturnValue(null);

      await extractor.writeMemories('group1', 'User: hi\nBot: hey');

      const prompt = mockSpawn.mock.calls[0][1][1];
      expect(prompt).not.toContain('already saved these memories');
    });

    it('uses write timeout (60s) not read timeout', async () => {
      mockSpawn.mockResolvedValue('');
      mockExtract.mockReturnValue(null);

      await extractor.writeMemories('group1', 'conv');

      const opts = mockSpawn.mock.calls[0][2];
      expect(opts.timeout).toBe(60_000);
    });

    it('does not throw on spawn error', async () => {
      mockSpawn.mockRejectedValue(new Error('process killed'));

      // Should not throw — errors are caught and logged
      await expect(extractor.writeMemories('group1', 'conv')).resolves.toBeUndefined();
    });
  });

  describe('scheduleExtraction', () => {
    it('debounces multiple calls for the same group', async () => {
      vi.useFakeTimers();

      extractor.scheduleExtraction('group1', 'msg1', 'resp1');
      extractor.scheduleExtraction('group1', 'msg2', 'resp2');

      // Should not have spawned yet (debounce pending)
      expect(mockSpawn).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5000);

      // Now it should fire once with combined conversation
      expect(mockSpawn).toHaveBeenCalledOnce();
      const prompt = mockSpawn.mock.calls[0][1][1];
      expect(prompt).toContain('msg1');
      expect(prompt).toContain('resp1');
      expect(prompt).toContain('msg2');
      expect(prompt).toContain('resp2');

      vi.useRealTimers();
    });

    it('keeps groups independent', async () => {
      vi.useFakeTimers();

      extractor.scheduleExtraction('group1', 'msg-a', 'resp-a');
      extractor.scheduleExtraction('group2', 'msg-b', 'resp-b');

      await vi.advanceTimersByTimeAsync(5000);

      expect(mockSpawn).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    it('resets debounce timer on subsequent calls', async () => {
      vi.useFakeTimers();

      extractor.scheduleExtraction('group1', 'msg1', 'resp1');
      await vi.advanceTimersByTimeAsync(3000);
      // Second call at t=3s resets the 5s timer
      extractor.scheduleExtraction('group1', 'msg2', 'resp2');

      await vi.advanceTimersByTimeAsync(3000); // t=6s — only 3s since last schedule
      expect(mockSpawn).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2000); // t=8s — 5s since last schedule
      expect(mockSpawn).toHaveBeenCalledOnce();

      vi.useRealTimers();
    });

    it('merges savedTitles across debounced calls', async () => {
      vi.useFakeTimers();

      extractor.scheduleExtraction('group1', 'msg1', 'resp1', ['Title A']);
      extractor.scheduleExtraction('group1', 'msg2', 'resp2', ['Title B']);

      await vi.advanceTimersByTimeAsync(5000);

      const prompt = mockSpawn.mock.calls[0][1][1];
      expect(prompt).toContain('Title A');
      expect(prompt).toContain('Title B');

      vi.useRealTimers();
    });

    it('does not fire after clearTimers', async () => {
      vi.useFakeTimers();

      extractor.scheduleExtraction('group1', 'msg', 'resp');
      extractor.clearTimers();

      await vi.advanceTimersByTimeAsync(10_000);
      expect(mockSpawn).not.toHaveBeenCalled();

      vi.useRealTimers();
    });
  });

  describe('buildHaikuArgs', () => {
    it('constructs correct CLI arguments', async () => {
      mockSpawn.mockResolvedValue('');
      mockExtract.mockReturnValue(null);

      await extractor.readMemories('g', 'msg');

      const [cmd, args] = mockSpawn.mock.calls[0];
      expect(cmd).toBe('claude');
      expect(args).toEqual([
        '-p',
        expect.stringContaining('memory retrieval assistant'),
        '--output-format',
        'json',
        '--max-turns',
        '5',
        '--no-session-persistence',
        '--model',
        'claude-haiku-4-5-20251001',
        '--allowedTools',
        'Bash',
      ]);
    });

    it('uses max-turns 10 for writes', async () => {
      mockSpawn.mockResolvedValue('');
      mockExtract.mockReturnValue(null);

      await extractor.writeMemories('g', 'conv');

      const args = mockSpawn.mock.calls[0][1];
      const maxTurnsIdx = args.indexOf('--max-turns');
      expect(args[maxTurnsIdx + 1]).toBe('10');
    });
  });

  describe('limiter integration', () => {
    it('serializes concurrent writeMemories calls', async () => {
      const callOrder: number[] = [];
      let callCount = 0;

      mockSpawn.mockImplementation(async () => {
        const n = ++callCount;
        callOrder.push(n);
        // Simulate async work
        await new Promise(r => setTimeout(r, 10));
        return '';
      });
      mockExtract.mockReturnValue(null);

      // Fire two writes concurrently — limiter has concurrency=1
      const p1 = extractor.writeMemories('g1', 'conv1');
      const p2 = extractor.writeMemories('g2', 'conv2');

      await Promise.all([p1, p2]);

      // Both should have completed, in order (serialized by limiter)
      expect(callOrder).toEqual([1, 2]);
      expect(mockSpawn).toHaveBeenCalledTimes(2);
    });
  });
});
