import { afterEach, describe, expect, it } from 'vitest';
import { MemoryExtractor } from '../src/memoryExtractor';

describe('MemoryExtractor', () => {
  let extractor: MemoryExtractor;

  afterEach(() => {
    extractor?.clearTimers();
    extractor?.killAll();
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
});
