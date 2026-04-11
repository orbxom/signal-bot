import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseConnection } from '../../db';
import { MemoryStore } from '../../stores/memoryStore';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('MemoryStore.listAll', () => {
  let conn: DatabaseConnection;
  let store: MemoryStore;
  const dbPath = join(tmpdir(), `test-memory-${Date.now()}.db`);

  beforeEach(() => {
    conn = new DatabaseConnection(dbPath);
    store = new MemoryStore(conn);
  });

  afterEach(() => {
    conn.db.close();
    try {
      unlinkSync(dbPath);
      unlinkSync(dbPath + '-wal');
      unlinkSync(dbPath + '-shm');
    } catch {}
  });

  it('returns empty array when no memories exist', () => {
    const result = store.listAll({});
    expect(result).toEqual([]);
  });

  it('returns all memories across groups', () => {
    store.save('group1', 'title1', 'text', { content: 'content1' });
    store.save('group2', 'title2', 'note', { content: 'content2' });

    const result = store.listAll({});
    expect(result).toHaveLength(2);
    expect(result.map(m => m.title).sort()).toEqual(['title1', 'title2']);
  });

  it('filters by groupId when provided', () => {
    store.save('group1', 'title1', 'text', { content: 'content1' });
    store.save('group2', 'title2', 'text', { content: 'content2' });

    const result = store.listAll({ groupId: 'group1' });
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('title1');
  });

  it('respects limit parameter', () => {
    store.save('group1', 'title1', 'text');
    store.save('group1', 'title2', 'text');
    store.save('group1', 'title3', 'text');

    const result = store.listAll({ limit: 2 });
    expect(result).toHaveLength(2);
  });

  it('respects offset parameter', () => {
    store.save('group1', 'a', 'text');
    store.save('group1', 'b', 'text');
    store.save('group1', 'c', 'text');

    const all = store.listAll({});
    const offset = store.listAll({ offset: 1 });

    expect(offset).toHaveLength(2);
    expect(offset[0].id).toBe(all[1].id);
  });

  it('includes tags in results', () => {
    store.save('group1', 'tagged', 'text', { tags: ['foo', 'bar'] });

    const result = store.listAll({});
    expect(result).toHaveLength(1);
    expect(result[0].tags).toEqual(['bar', 'foo']);
  });
});
