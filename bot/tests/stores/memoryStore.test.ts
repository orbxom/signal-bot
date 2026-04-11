import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../../src/stores/memoryStore';
import { createTestDb, type TestDb } from '../helpers/testDb';

describe('MemoryStore', () => {
  let db: TestDb;
  let store: MemoryStore;

  const setup = () => {
    db = createTestDb('signal-bot-memory-store-test-');
    store = new MemoryStore(db.conn);
    return store;
  };

  afterEach(() => {
    db?.cleanup();
  });

  describe('save (create / upsert)', () => {
    it('should create a new memory', () => {
      setup();
      const memory = store.save('group1', 'groceries', 'note');
      expect(memory).toMatchObject({
        groupId: 'group1',
        title: 'groceries',
        type: 'note',
        tags: [],
      });
      expect(memory.id).toBeGreaterThan(0);
      expect(memory.createdAt).toBeGreaterThan(0);
      expect(memory.updatedAt).toBeGreaterThan(0);
    });

    it('should create memory with optional fields', () => {
      setup();
      const memory = store.save('group1', 'My Recipe', 'recipe', {
        description: 'A tasty dish',
        content: 'Boil water...',
        tags: ['food', 'easy'],
      });
      expect(memory.description).toBe('A tasty dish');
      expect(memory.content).toBe('Boil water...');
      expect(memory.tags).toEqual(['easy', 'food']); // sorted
    });

    it('should upsert by (groupId, title)', () => {
      setup();
      const first = store.save('group1', 'groceries', 'note', { content: 'Buy milk' });
      const second = store.save('group1', 'groceries', 'note', { content: 'Buy milk and eggs' });
      expect(second.id).toBe(first.id);
      expect(second.content).toBe('Buy milk and eggs');
    });

    it('should preserve createdAt on upsert but update updatedAt', async () => {
      setup();
      const first = store.save('group1', 'groceries', 'note');
      await new Promise(resolve => setTimeout(resolve, 20));
      const second = store.save('group1', 'groceries', 'note', { content: 'Updated' });
      expect(second.createdAt).toBe(first.createdAt);
      expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
    });

    it('should replace tags entirely on upsert', () => {
      setup();
      store.save('group1', 'groceries', 'note', { tags: ['food', 'shopping'] });
      const second = store.save('group1', 'groceries', 'note', { tags: ['important'] });
      expect(second.tags).toEqual(['important']);
    });

    it('should normalize type to lowercase and trim', () => {
      setup();
      const memory = store.save('group1', 'title', '  NOTE  ');
      expect(memory.type).toBe('note');
    });

    it('should normalize tags: lowercase, trim, dedup, sort', () => {
      setup();
      const memory = store.save('group1', 'title', 'note', {
        tags: ['  Food  ', 'food', 'EASY', 'easy'],
      });
      expect(memory.tags).toEqual(['easy', 'food']);
    });

    it('should reject empty groupId', () => {
      setup();
      expect(() => store.save('', 'title', 'note')).toThrow('Invalid groupId: cannot be empty');
    });

    it('should reject empty title', () => {
      setup();
      expect(() => store.save('group1', '', 'note')).toThrow('Invalid title: cannot be empty');
    });

    it('should reject empty type', () => {
      setup();
      expect(() => store.save('group1', 'title', '')).toThrow('Invalid type: cannot be empty');
    });
  });

  describe('update', () => {
    it('should partially update a memory', () => {
      setup();
      const original = store.save('group1', 'groceries', 'note', { content: 'Buy milk' });
      const updated = store.update(original.id, { content: 'Buy milk and eggs' });
      expect(updated).not.toBeNull();
      expect(updated?.content).toBe('Buy milk and eggs');
      expect(updated?.title).toBe('groceries'); // unchanged
    });

    it('should update title', () => {
      setup();
      const original = store.save('group1', 'old-title', 'note');
      const updated = store.update(original.id, { title: 'new-title' });
      expect(updated?.title).toBe('new-title');
    });

    it('should update type with normalization', () => {
      setup();
      const original = store.save('group1', 'title', 'note');
      const updated = store.update(original.id, { type: '  RECIPE  ' });
      expect(updated?.type).toBe('recipe');
    });

    it('should replace tags entirely when provided', () => {
      setup();
      const original = store.save('group1', 'title', 'note', { tags: ['old', 'tags'] });
      const updated = store.update(original.id, { tags: ['new'] });
      expect(updated?.tags).toEqual(['new']);
    });

    it('should clear tags when empty array provided', () => {
      setup();
      const original = store.save('group1', 'title', 'note', { tags: ['tag1'] });
      const updated = store.update(original.id, { tags: [] });
      expect(updated?.tags).toEqual([]);
    });

    it('should return null for non-existent id', () => {
      setup();
      const result = store.update(9999, { content: 'nope' });
      expect(result).toBeNull();
    });

    it('should update updatedAt', async () => {
      setup();
      const original = store.save('group1', 'title', 'note');
      await new Promise(resolve => setTimeout(resolve, 20));
      const updated = store.update(original.id, { description: 'changed' });
      expect(updated?.updatedAt).toBeGreaterThanOrEqual(original.updatedAt);
    });
  });

  describe('getById', () => {
    it('should return memory with tags for existing id', () => {
      setup();
      const saved = store.save('group1', 'title', 'note', { tags: ['tag1'] });
      const fetched = store.getById(saved.id);
      expect(fetched).not.toBeNull();
      expect(fetched?.title).toBe('title');
      expect(fetched?.tags).toEqual(['tag1']);
    });

    it('should return null for non-existent id', () => {
      setup();
      expect(store.getById(9999)).toBeNull();
    });
  });

  describe('search', () => {
    it('should return all memories for group when no filters', () => {
      setup();
      store.save('group1', 'groceries', 'note');
      store.save('group1', 'todos', 'task');
      const results = store.search('group1', {});
      expect(results).toHaveLength(2);
    });

    it('should isolate results by group', () => {
      setup();
      store.save('group1', 'groceries', 'note');
      store.save('group2', 'todos', 'task');
      const results = store.search('group1', {});
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('groceries');
    });

    it('should filter by keyword in title', () => {
      setup();
      store.save('group1', 'grocery list', 'note');
      store.save('group1', 'meeting notes', 'note');
      const results = store.search('group1', { keyword: 'grocery' });
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('grocery list');
    });

    it('should filter by keyword in description', () => {
      setup();
      store.save('group1', 'title1', 'note', { description: 'contains banana' });
      store.save('group1', 'title2', 'note', { description: 'no fruit here' });
      const results = store.search('group1', { keyword: 'banana' });
      expect(results).toHaveLength(1);
    });

    it('should filter by keyword in content', () => {
      setup();
      store.save('group1', 'title1', 'note', { content: 'secret content here' });
      store.save('group1', 'title2', 'note', { content: 'nothing special' });
      const results = store.search('group1', { keyword: 'secret' });
      expect(results).toHaveLength(1);
    });

    it('should filter by type', () => {
      setup();
      store.save('group1', 'item1', 'note');
      store.save('group1', 'item2', 'recipe');
      store.save('group1', 'item3', 'note');
      const results = store.search('group1', { type: 'recipe' });
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('item2');
    });

    it('should filter by tag', () => {
      setup();
      store.save('group1', 'item1', 'note', { tags: ['food'] });
      store.save('group1', 'item2', 'note', { tags: ['work'] });
      store.save('group1', 'item3', 'note', { tags: ['food', 'work'] });
      const results = store.search('group1', { tag: 'food' });
      expect(results).toHaveLength(2);
      const titles = results.map(r => r.title).sort();
      expect(titles).toEqual(['item1', 'item3']);
    });

    it('should sort by updatedAt DESC', async () => {
      setup();
      store.save('group1', 'first', 'note');
      await new Promise(resolve => setTimeout(resolve, 10));
      store.save('group1', 'second', 'note');
      const results = store.search('group1', {});
      expect(results[0].title).toBe('second');
      expect(results[1].title).toBe('first');
    });

    it('should respect limit parameter', () => {
      setup();
      for (let i = 0; i < 10; i++) {
        store.save('group1', `item${i}`, 'note');
      }
      const results = store.search('group1', {}, 5);
      expect(results).toHaveLength(5);
    });

    it('should cap limit at 1000', () => {
      setup();
      for (let i = 0; i < 110; i++) {
        store.save('group1', `item${i}`, 'note');
      }
      const results = store.search('group1', {}, 2000);
      expect(results).toHaveLength(110);
    });

    it('should default limit to 20', () => {
      setup();
      for (let i = 0; i < 25; i++) {
        store.save('group1', `item${i}`, 'note');
      }
      const results = store.search('group1', {});
      expect(results).toHaveLength(20);
    });

    it('should include tags in results', () => {
      setup();
      store.save('group1', 'tagged', 'note', { tags: ['a', 'b'] });
      const results = store.search('group1', {});
      expect(results[0].tags).toEqual(['a', 'b']);
    });
  });

  describe('listTypes', () => {
    it('should return distinct types for a group', () => {
      setup();
      store.save('group1', 'item1', 'note');
      store.save('group1', 'item2', 'recipe');
      store.save('group1', 'item3', 'note');
      const types = store.listTypes('group1');
      expect(types.sort()).toEqual(['note', 'recipe']);
    });

    it('should not include types from other groups', () => {
      setup();
      store.save('group1', 'item1', 'note');
      store.save('group2', 'item2', 'recipe');
      const types = store.listTypes('group1');
      expect(types).toEqual(['note']);
    });

    it('should return empty array when no memories', () => {
      setup();
      expect(store.listTypes('group1')).toEqual([]);
    });
  });

  describe('listTags', () => {
    it('should return distinct tags for a group', () => {
      setup();
      store.save('group1', 'item1', 'note', { tags: ['food', 'easy'] });
      store.save('group1', 'item2', 'note', { tags: ['food', 'hard'] });
      const tags = store.listTags('group1');
      expect(tags.sort()).toEqual(['easy', 'food', 'hard']);
    });

    it('should not include tags from other groups', () => {
      setup();
      store.save('group1', 'item1', 'note', { tags: ['tag-a'] });
      store.save('group2', 'item2', 'note', { tags: ['tag-b'] });
      const tags = store.listTags('group1');
      expect(tags).toEqual(['tag-a']);
    });

    it('should return empty array when no tags', () => {
      setup();
      store.save('group1', 'item1', 'note');
      expect(store.listTags('group1')).toEqual([]);
    });
  });

  describe('manageTags', () => {
    it('should add tags', () => {
      setup();
      const original = store.save('group1', 'title', 'note', { tags: ['existing'] });
      const updated = store.manageTags(original.id, ['new'], []);
      expect(updated?.tags.sort()).toEqual(['existing', 'new']);
    });

    it('should remove tags', () => {
      setup();
      const original = store.save('group1', 'title', 'note', { tags: ['keep', 'remove'] });
      const updated = store.manageTags(original.id, [], ['remove']);
      expect(updated?.tags).toEqual(['keep']);
    });

    it('should add and remove in same call', () => {
      setup();
      const original = store.save('group1', 'title', 'note', { tags: ['old'] });
      const updated = store.manageTags(original.id, ['new'], ['old']);
      expect(updated?.tags).toEqual(['new']);
    });

    it('should be idempotent for adding existing tag', () => {
      setup();
      const original = store.save('group1', 'title', 'note', { tags: ['tag1'] });
      const updated = store.manageTags(original.id, ['tag1'], []);
      expect(updated?.tags).toEqual(['tag1']);
    });

    it('should update updatedAt', async () => {
      setup();
      const original = store.save('group1', 'title', 'note');
      await new Promise(resolve => setTimeout(resolve, 20));
      const updated = store.manageTags(original.id, ['newtag'], []);
      expect(updated?.updatedAt).toBeGreaterThanOrEqual(original.updatedAt);
    });

    it('should return null for non-existent id', () => {
      setup();
      const result = store.manageTags(9999, ['tag'], []);
      expect(result).toBeNull();
    });
  });

  describe('deleteById', () => {
    it('should delete an existing memory and cascade tags', () => {
      setup();
      const memory = store.save('group1', 'title', 'note', { tags: ['tag1'] });
      const result = store.deleteById(memory.id);
      expect(result).toBe(true);
      expect(store.getById(memory.id)).toBeNull();
    });

    it('should return false for non-existent id', () => {
      setup();
      expect(store.deleteById(9999)).toBe(false);
    });
  });

  describe('getByGroup', () => {
    it('should return all memories for group (delegates to search with limit 1000)', () => {
      setup();
      store.save('group1', 'item1', 'note');
      store.save('group1', 'item2', 'task');
      store.save('group2', 'other', 'note');
      const results = store.getByGroup('group1');
      expect(results).toHaveLength(2);
      expect(results.every(m => m.groupId === 'group1')).toBe(true);
    });
  });
});
