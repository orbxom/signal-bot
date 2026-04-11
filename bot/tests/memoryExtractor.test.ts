import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnCollect } from '../src/claudeClient';
import { MemoryExtractor } from '../src/memoryExtractor';

vi.mock('../src/claudeClient', () => ({
  spawnCollect: vi.fn(),
  parseEntries: vi.fn(() => []),
}));

describe('MemoryExtractor', () => {
  let extractor: MemoryExtractor;

  afterEach(() => {
    extractor?.clearTimers();
    extractor?.killAll();
    vi.clearAllMocks();
  });

  it('should construct with a dbPath', () => {
    extractor = new MemoryExtractor('/tmp/test.db');
    expect(extractor).toBeDefined();
  });

  it('should schedule and clear timers', () => {
    extractor = new MemoryExtractor('/tmp/test.db');
    extractor.scheduleExtraction('group1', 'hello', 'hi there');
    extractor.clearTimers();
  });

  it('should debounce multiple schedule calls', () => {
    extractor = new MemoryExtractor('/tmp/test.db');
    extractor.scheduleExtraction('group1', 'msg1', 'resp1');
    extractor.scheduleExtraction('group1', 'msg2', 'resp2');
    extractor.clearTimers();
  });

  it('should include savedTitles in the write prompt', async () => {
    vi.mocked(spawnCollect).mockResolvedValue(JSON.stringify({ type: 'result', result: '' }));
    extractor = new MemoryExtractor('/tmp/test.db');
    await extractor.writeMemories('group1', 'User: hello\nBot: hi there', ["Dad's birthday", 'Likes pizza']);
    const prompt = vi.mocked(spawnCollect).mock.calls[0][1][1]; // args[1] is the prompt
    expect(prompt).toContain('The bot already saved these memories');
    expect(prompt).toContain("Dad's birthday");
    expect(prompt).toContain('Likes pizza');
  });

  it('should NOT include savedTitles section when titles are empty', async () => {
    vi.mocked(spawnCollect).mockResolvedValue(JSON.stringify({ type: 'result', result: '' }));
    extractor = new MemoryExtractor('/tmp/test.db');
    await extractor.writeMemories('group1', 'User: hello\nBot: hi there', []);
    const prompt = vi.mocked(spawnCollect).mock.calls[0][1][1];
    expect(prompt).not.toContain('already saved these memories');
  });
});
