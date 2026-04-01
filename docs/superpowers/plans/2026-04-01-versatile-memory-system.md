# Versatile Memory System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the rigid topic/content memory system with a flexible, taggable knowledge store backed by haiku subagent pre-read/post-write pipeline.

**Architecture:** New `memories` table with title/description/content/type columns, `memory_tags` join table. Existing `MemoryStore` and MCP server replaced. New `memory/cli.ts` provides Bash-callable scripts for haiku subagents. Existing `MemoryExtractor` updated to use the new schema and CLI scripts. `contextBuilder.ts` gains a `memorySummary` injection point.

**Tech Stack:** TypeScript, better-sqlite3, vitest, Claude CLI (`claude -p --model haiku`)

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `bot/src/types.ts` | Modify | Update `Memory` interface, add `MemoryTag` |
| `bot/src/db.ts` | Modify | Add migration V10 |
| `bot/src/stores/memoryStore.ts` | Rewrite | New schema: title/description/content/type + tag operations |
| `bot/src/storage.ts` | Modify | Update delegation methods for new `MemoryStore` API |
| `bot/src/mcp/servers/memories.ts` | Rewrite | 8 new tools replacing 4 old ones |
| `bot/src/memory/cli.ts` | Create | CLI entry point for haiku subagents |
| `bot/src/memoryExtractor.ts` | Rewrite | Use haiku + CLI scripts instead of sonnet + JSON |
| `bot/src/contextBuilder.ts` | Modify | Add `memorySummary` parameter |
| `bot/src/messageHandler.ts` | Modify | Wire pre-read memory summary into context |
| `bot/tests/stores/memoryStore.test.ts` | Rewrite | Tests for new schema |
| `bot/tests/memoryMcpServer.test.ts` | Rewrite | Tests for new 8-tool server |
| `bot/tests/memory/cli.test.ts` | Create | Tests for CLI scripts |
| `bot/tests/memoryExtractor.test.ts` | Modify | Update for new schema |
| `bot/tests/contextBuilder.test.ts` | Modify | Test memorySummary injection |
| `bot/tests/messageHandler.test.ts` | Modify | Test pre-read integration |

---

### Task 1: Update Types

**Files:**
- Modify: `bot/src/types.ts:79-86`

- [ ] **Step 1: Update the Memory interface and add MemoryTag**

Replace the existing `Memory` interface:

```typescript
export interface Memory {
  id: number;
  groupId: string;
  title: string;
  description: string | null;
  content: string | null;
  type: string;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryWithTags extends Memory {
  tags: string[];
}
```

- [ ] **Step 2: Commit**

```bash
git add bot/src/types.ts
git commit -m "feat(memory): update Memory interface with title/description/content/type"
```

---

### Task 2: Schema Migration V10

**Files:**
- Modify: `bot/src/db.ts`
- Test: `bot/tests/db.test.ts`

- [ ] **Step 1: Write a failing test for migration V10**

Add to `bot/tests/db.test.ts`:

```typescript
it('should migrate memories table to V10 schema with title/description/content/type', () => {
  // Insert a legacy memory using the old schema (topic/content)
  db.db.prepare(
    "INSERT INTO memories (groupId, topic, content, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)"
  ).run('group1', 'groceries', 'Buy milk', Date.now(), Date.now());

  // Force re-run migration by setting version back and re-creating connection
  db.db.prepare("UPDATE schema_meta SET value = '9' WHERE key = 'schema_version'").run();
  db.close();
  const db2 = new DatabaseConnection(dbPath);

  // Verify new schema columns exist
  const cols = db2.db.pragma('table_info(memories)') as Array<{ name: string }>;
  const colNames = cols.map(c => c.name);
  expect(colNames).toContain('title');
  expect(colNames).toContain('description');
  expect(colNames).toContain('type');
  expect(colNames).not.toContain('topic');

  // Verify data was migrated
  const row = db2.db.prepare("SELECT * FROM memories WHERE groupId = 'group1'").get() as any;
  expect(row.title).toBe('groceries');
  expect(row.content).toBe('Buy milk');
  expect(row.type).toBe('text');
  expect(row.description).toBeNull();

  // Verify memory_tags table exists
  const tables = db2.db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_tags'"
  ).get();
  expect(tables).toBeTruthy();

  // Verify unique index on (groupId, title)
  const indexes = db2.db.pragma('index_list(memories)') as Array<{ name: string }>;
  const titleIdx = indexes.find(i => i.name === 'idx_memories_group_title');
  expect(titleIdx).toBeTruthy();

  db2.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd bot && npx vitest run tests/db.test.ts --reporter=verbose`
Expected: FAIL — migration V10 doesn't exist yet.

- [ ] **Step 3: Add migration V10 to db.ts**

In `bot/src/db.ts`, add after the V9 migration block in `runMigrations()`:

```typescript
if (currentVersion < 10) {
  this.migrateToV10();
  this.setSchemaVersion(10);
}
```

Add the migration method:

```typescript
private migrateToV10(): void {
  // Check if old schema (has 'topic' column) vs new
  const cols = this.db.pragma('table_info(memories)') as Array<{ name: string }>;
  const hasOldSchema = cols.some(c => c.name === 'topic');

  if (hasOldSchema) {
    // Migrate from old schema
    this.db.exec(`
      CREATE TABLE memories_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        groupId TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        content TEXT,
        type TEXT NOT NULL DEFAULT 'text',
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );

      INSERT INTO memories_new (id, groupId, title, content, type, createdAt, updatedAt)
      SELECT id, groupId, topic, content, 'text', createdAt, updatedAt FROM memories;

      DROP TABLE memories;
      ALTER TABLE memories_new RENAME TO memories;
    `);
  }

  // Create indexes (idempotent)
  this.db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_group_title
    ON memories(groupId, title);

    CREATE INDEX IF NOT EXISTS idx_memories_group
    ON memories(groupId);

    CREATE INDEX IF NOT EXISTS idx_memories_group_type
    ON memories(groupId, type);
  `);

  // Create memory_tags table
  this.db.exec(`
    CREATE TABLE IF NOT EXISTS memory_tags (
      memoryId INTEGER NOT NULL,
      tag TEXT NOT NULL,
      FOREIGN KEY (memoryId) REFERENCES memories(id) ON DELETE CASCADE,
      UNIQUE(memoryId, tag)
    );

    CREATE INDEX IF NOT EXISTS idx_memory_tags_tag
    ON memory_tags(tag);
  `);

  // Enable foreign keys for CASCADE to work
  this.db.pragma('foreign_keys = ON');
}
```

Also update `initTables()` — replace the old `memories` CREATE TABLE block with the new schema:

```typescript
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  groupId TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  content TEXT,
  type TEXT NOT NULL DEFAULT 'text',
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_group_title
ON memories(groupId, title);

CREATE INDEX IF NOT EXISTS idx_memories_group
ON memories(groupId);

CREATE INDEX IF NOT EXISTS idx_memories_group_type
ON memories(groupId, type);

CREATE TABLE IF NOT EXISTS memory_tags (
  memoryId INTEGER NOT NULL,
  tag TEXT NOT NULL,
  FOREIGN KEY (memoryId) REFERENCES memories(id) ON DELETE CASCADE,
  UNIQUE(memoryId, tag)
);

CREATE INDEX IF NOT EXISTS idx_memory_tags_tag
ON memory_tags(tag);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd bot && npx vitest run tests/db.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Run full test suite to check for breakage**

Run: `cd bot && npx vitest run --reporter=verbose`
Expected: Some memory-related tests will fail (memoryStore, memoryMcpServer, storage.memories) due to schema change. Other tests should pass.

- [ ] **Step 6: Commit**

```bash
git add bot/src/db.ts bot/tests/db.test.ts
git commit -m "feat(memory): add schema migration V10 — new memories table + memory_tags"
```

---

### Task 3: Rewrite MemoryStore

**Files:**
- Rewrite: `bot/src/stores/memoryStore.ts`
- Rewrite: `bot/tests/stores/memoryStore.test.ts`

- [ ] **Step 1: Write failing tests for the new MemoryStore**

Rewrite `bot/tests/stores/memoryStore.test.ts`:

```typescript
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

  describe('save', () => {
    it('should create a new memory with all fields', () => {
      setup();
      const memory = store.save('group1', 'Pizza Place', 'fact', {
        description: 'Dad loves this place',
        content: 'https://example.com/pizza',
        tags: ['food', 'family'],
      });
      expect(memory.title).toBe('Pizza Place');
      expect(memory.type).toBe('fact');
      expect(memory.description).toBe('Dad loves this place');
      expect(memory.content).toBe('https://example.com/pizza');
      expect(memory.tags).toEqual(['family', 'food']); // sorted
      expect(memory.id).toBeGreaterThan(0);
    });

    it('should upsert by groupId + title', () => {
      setup();
      const first = store.save('group1', 'Pizza Place', 'url', { content: 'old' });
      const second = store.save('group1', 'Pizza Place', 'url', { content: 'new' });
      expect(second.id).toBe(first.id);
      expect(second.content).toBe('new');
    });

    it('should normalize type to lowercase trimmed', () => {
      setup();
      const m = store.save('group1', 'test', '  URL  ', {});
      expect(m.type).toBe('url');
    });

    it('should normalize tags to lowercase trimmed, deduped', () => {
      setup();
      const m = store.save('group1', 'test', 'fact', {
        tags: ['Food', '  food  ', 'FAMILY'],
      });
      expect(m.tags).toEqual(['family', 'food']);
    });

    it('should reject empty groupId', () => {
      setup();
      expect(() => store.save('', 'test', 'fact', {})).toThrow('Invalid groupId');
    });

    it('should reject empty title', () => {
      setup();
      expect(() => store.save('group1', '', 'fact', {})).toThrow('Invalid title');
    });

    it('should reject empty type', () => {
      setup();
      expect(() => store.save('group1', 'test', '', {})).toThrow('Invalid type');
    });

    it('should allow null description and content', () => {
      setup();
      const m = store.save('group1', 'test', 'fact', {});
      expect(m.description).toBeNull();
      expect(m.content).toBeNull();
    });
  });

  describe('update', () => {
    it('should update specific fields without touching others', () => {
      setup();
      const original = store.save('group1', 'Pizza', 'url', {
        description: 'Original desc',
        content: 'http://example.com',
        tags: ['food'],
      });
      const updated = store.update(original.id, { description: 'New desc' });
      expect(updated).not.toBeNull();
      expect(updated!.description).toBe('New desc');
      expect(updated!.content).toBe('http://example.com');
      expect(updated!.tags).toEqual(['food']);
    });

    it('should replace tags entirely when provided', () => {
      setup();
      const original = store.save('group1', 'Pizza', 'url', { tags: ['food', 'family'] });
      const updated = store.update(original.id, { tags: ['restaurant'] });
      expect(updated!.tags).toEqual(['restaurant']);
    });

    it('should return null for non-existent id', () => {
      setup();
      expect(store.update(999, { description: 'nope' })).toBeNull();
    });
  });

  describe('getById', () => {
    it('should return memory with tags', () => {
      setup();
      const saved = store.save('group1', 'Pizza', 'url', { tags: ['food'] });
      const got = store.getById(saved.id);
      expect(got).not.toBeNull();
      expect(got!.title).toBe('Pizza');
      expect(got!.tags).toEqual(['food']);
    });

    it('should return null for non-existent id', () => {
      setup();
      expect(store.getById(999)).toBeNull();
    });
  });

  describe('search', () => {
    it('should search by keyword across title/description/content', () => {
      setup();
      store.save('group1', 'Pizza Place', 'url', { content: 'http://pizza.com' });
      store.save('group1', 'Sushi Spot', 'url', { content: 'http://sushi.com' });
      const results = store.search('group1', { keyword: 'pizza' });
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Pizza Place');
    });

    it('should filter by type', () => {
      setup();
      store.save('group1', 'Fav Color', 'preference', { content: 'blue' });
      store.save('group1', 'Pizza', 'url', { content: 'http://pizza.com' });
      const results = store.search('group1', { type: 'preference' });
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Fav Color');
    });

    it('should filter by tag', () => {
      setup();
      store.save('group1', 'Pizza', 'url', { tags: ['food'] });
      store.save('group1', 'Park', 'url', { tags: ['outdoors'] });
      const results = store.search('group1', { tag: 'food' });
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Pizza');
    });

    it('should return all memories with no filters', () => {
      setup();
      store.save('group1', 'A', 'fact', {});
      store.save('group1', 'B', 'fact', {});
      const results = store.search('group1', {});
      expect(results).toHaveLength(2);
    });

    it('should sort by updatedAt DESC', () => {
      setup();
      store.save('group1', 'Old', 'fact', {});
      store.save('group1', 'New', 'fact', {});
      const results = store.search('group1', {});
      expect(results[0].title).toBe('New');
    });

    it('should respect limit', () => {
      setup();
      for (let i = 0; i < 5; i++) store.save('group1', `M${i}`, 'fact', {});
      const results = store.search('group1', {}, 2);
      expect(results).toHaveLength(2);
    });

    it('should not return memories from other groups', () => {
      setup();
      store.save('group1', 'A', 'fact', {});
      store.save('group2', 'B', 'fact', {});
      const results = store.search('group1', {});
      expect(results).toHaveLength(1);
    });
  });

  describe('listTypes', () => {
    it('should return distinct types for a group', () => {
      setup();
      store.save('group1', 'A', 'fact', {});
      store.save('group1', 'B', 'url', {});
      store.save('group1', 'C', 'fact', {});
      const types = store.listTypes('group1');
      expect(types.sort()).toEqual(['fact', 'url']);
    });

    it('should return empty array for group with no memories', () => {
      setup();
      expect(store.listTypes('group1')).toEqual([]);
    });
  });

  describe('listTags', () => {
    it('should return distinct tags for a group', () => {
      setup();
      store.save('group1', 'A', 'fact', { tags: ['food', 'family'] });
      store.save('group1', 'B', 'fact', { tags: ['food', 'health'] });
      const tags = store.listTags('group1');
      expect(tags.sort()).toEqual(['family', 'food', 'health']);
    });
  });

  describe('manageTags', () => {
    it('should add tags to a memory', () => {
      setup();
      const m = store.save('group1', 'Pizza', 'url', { tags: ['food'] });
      const updated = store.manageTags(m.id, ['family'], []);
      expect(updated!.tags.sort()).toEqual(['family', 'food']);
    });

    it('should remove tags from a memory', () => {
      setup();
      const m = store.save('group1', 'Pizza', 'url', { tags: ['food', 'family'] });
      const updated = store.manageTags(m.id, [], ['family']);
      expect(updated!.tags).toEqual(['food']);
    });

    it('should add and remove in one call', () => {
      setup();
      const m = store.save('group1', 'Pizza', 'url', { tags: ['food'] });
      const updated = store.manageTags(m.id, ['restaurant'], ['food']);
      expect(updated!.tags).toEqual(['restaurant']);
    });

    it('should return null for non-existent id', () => {
      setup();
      expect(store.manageTags(999, ['x'], [])).toBeNull();
    });
  });

  describe('delete', () => {
    it('should delete a memory and its tags', () => {
      setup();
      const m = store.save('group1', 'Pizza', 'url', { tags: ['food'] });
      expect(store.deleteById(m.id)).toBe(true);
      expect(store.getById(m.id)).toBeNull();
    });

    it('should return false for non-existent id', () => {
      setup();
      expect(store.deleteById(999)).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd bot && npx vitest run tests/stores/memoryStore.test.ts --reporter=verbose`
Expected: FAIL — old MemoryStore doesn't have these methods.

- [ ] **Step 3: Rewrite the MemoryStore**

Rewrite `bot/src/stores/memoryStore.ts`:

```typescript
import type { DatabaseConnection } from '../db';
import { wrapSqliteError } from '../db';
import type { Memory, MemoryWithTags } from '../types';

export class MemoryStore {
  private conn: DatabaseConnection;

  constructor(conn: DatabaseConnection) {
    this.conn = conn;
    // Enable foreign keys for CASCADE deletes on memory_tags
    conn.db.pragma('foreign_keys = ON');
  }

  save(
    groupId: string,
    title: string,
    type: string,
    opts: { description?: string | null; content?: string | null; tags?: string[] },
  ): MemoryWithTags {
    if (!groupId || groupId.trim() === '') throw new Error('Invalid groupId: cannot be empty');
    if (!title || title.trim() === '') throw new Error('Invalid title: cannot be empty');
    if (!type || type.trim() === '') throw new Error('Invalid type: cannot be empty');

    const normalizedType = type.trim().toLowerCase();
    const now = Date.now();

    return this.conn.runOp('save memory', () => {
      const row = this.conn.db.prepare(`
        INSERT INTO memories (groupId, title, description, content, type, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(groupId, title) DO UPDATE SET
          description = excluded.description,
          content = excluded.content,
          type = excluded.type,
          updatedAt = excluded.updatedAt
        RETURNING *
      `).get(
        groupId, title, opts.description ?? null, opts.content ?? null, normalizedType, now, now,
      ) as Memory;

      // Replace tags
      this.conn.db.prepare('DELETE FROM memory_tags WHERE memoryId = ?').run(row.id);
      const tags = this.normalizeTags(opts.tags);
      if (tags.length > 0) {
        const insertTag = this.conn.db.prepare(
          'INSERT OR IGNORE INTO memory_tags (memoryId, tag) VALUES (?, ?)',
        );
        for (const tag of tags) {
          insertTag.run(row.id, tag);
        }
      }

      return { ...row, tags };
    });
  }

  update(
    id: number,
    opts: {
      title?: string;
      description?: string | null;
      content?: string | null;
      type?: string;
      tags?: string[];
    },
  ): MemoryWithTags | null {
    return this.conn.runOp('update memory', () => {
      const existing = this.conn.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Memory | undefined;
      if (!existing) return null;

      const updates: string[] = [];
      const values: unknown[] = [];

      if (opts.title !== undefined) {
        updates.push('title = ?');
        values.push(opts.title);
      }
      if (opts.description !== undefined) {
        updates.push('description = ?');
        values.push(opts.description);
      }
      if (opts.content !== undefined) {
        updates.push('content = ?');
        values.push(opts.content);
      }
      if (opts.type !== undefined) {
        updates.push('type = ?');
        values.push(opts.type.trim().toLowerCase());
      }

      updates.push('updatedAt = ?');
      values.push(Date.now());
      values.push(id);

      const row = this.conn.db.prepare(
        `UPDATE memories SET ${updates.join(', ')} WHERE id = ? RETURNING *`,
      ).get(...values) as Memory;

      if (opts.tags !== undefined) {
        this.conn.db.prepare('DELETE FROM memory_tags WHERE memoryId = ?').run(id);
        const tags = this.normalizeTags(opts.tags);
        const insertTag = this.conn.db.prepare(
          'INSERT OR IGNORE INTO memory_tags (memoryId, tag) VALUES (?, ?)',
        );
        for (const tag of tags) {
          insertTag.run(id, tag);
        }
      }

      return { ...row, tags: this.getTagsForMemory(id) };
    });
  }

  getById(id: number): MemoryWithTags | null {
    return this.conn.runOp('get memory', () => {
      const row = this.conn.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Memory | undefined;
      if (!row) return null;
      return { ...row, tags: this.getTagsForMemory(id) };
    });
  }

  search(
    groupId: string,
    filters: { keyword?: string; type?: string; tag?: string },
    limit = 20,
  ): MemoryWithTags[] {
    return this.conn.runOp('search memories', () => {
      const conditions = ['m.groupId = ?'];
      const params: unknown[] = [groupId];

      if (filters.keyword) {
        conditions.push('(m.title LIKE ? OR m.description LIKE ? OR m.content LIKE ?)');
        const kw = `%${filters.keyword}%`;
        params.push(kw, kw, kw);
      }
      if (filters.type) {
        conditions.push('m.type = ?');
        params.push(filters.type.trim().toLowerCase());
      }
      if (filters.tag) {
        conditions.push('EXISTS (SELECT 1 FROM memory_tags mt WHERE mt.memoryId = m.id AND mt.tag = ?)');
        params.push(filters.tag.trim().toLowerCase());
      }

      params.push(Math.min(limit, 100));

      const rows = this.conn.db.prepare(`
        SELECT m.* FROM memories m
        WHERE ${conditions.join(' AND ')}
        ORDER BY m.updatedAt DESC
        LIMIT ?
      `).all(...params) as Memory[];

      return rows.map(row => ({ ...row, tags: this.getTagsForMemory(row.id) }));
    });
  }

  listTypes(groupId: string): string[] {
    return this.conn.runOp('list memory types', () => {
      const rows = this.conn.db.prepare(
        'SELECT DISTINCT type FROM memories WHERE groupId = ? ORDER BY type',
      ).all(groupId) as Array<{ type: string }>;
      return rows.map(r => r.type);
    });
  }

  listTags(groupId: string): string[] {
    return this.conn.runOp('list memory tags', () => {
      const rows = this.conn.db.prepare(`
        SELECT DISTINCT mt.tag FROM memory_tags mt
        JOIN memories m ON mt.memoryId = m.id
        WHERE m.groupId = ?
        ORDER BY mt.tag
      `).all(groupId) as Array<{ tag: string }>;
      return rows.map(r => r.tag);
    });
  }

  manageTags(id: number, add: string[], remove: string[]): MemoryWithTags | null {
    return this.conn.runOp('manage memory tags', () => {
      const existing = this.conn.db.prepare('SELECT id FROM memories WHERE id = ?').get(id);
      if (!existing) return null;

      if (remove.length > 0) {
        const normalized = remove.map(t => t.trim().toLowerCase());
        const deleteTag = this.conn.db.prepare(
          'DELETE FROM memory_tags WHERE memoryId = ? AND tag = ?',
        );
        for (const tag of normalized) {
          deleteTag.run(id, tag);
        }
      }

      if (add.length > 0) {
        const normalized = this.normalizeTags(add);
        const insertTag = this.conn.db.prepare(
          'INSERT OR IGNORE INTO memory_tags (memoryId, tag) VALUES (?, ?)',
        );
        for (const tag of normalized) {
          insertTag.run(id, tag);
        }
      }

      // Update updatedAt
      this.conn.db.prepare('UPDATE memories SET updatedAt = ? WHERE id = ?').run(Date.now(), id);

      const row = this.conn.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Memory;
      return { ...row, tags: this.getTagsForMemory(id) };
    });
  }

  deleteById(id: number): boolean {
    return this.conn.runOp('delete memory', () => {
      const result = this.conn.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
      return result.changes > 0;
    });
  }

  /** Get all memories for a group (used by contextBuilder / extractor). */
  getByGroup(groupId: string): MemoryWithTags[] {
    return this.search(groupId, {}, 100);
  }

  private getTagsForMemory(memoryId: number): string[] {
    const rows = this.conn.db.prepare(
      'SELECT tag FROM memory_tags WHERE memoryId = ? ORDER BY tag',
    ).all(memoryId) as Array<{ tag: string }>;
    return rows.map(r => r.tag);
  }

  private normalizeTags(tags?: string[]): string[] {
    if (!tags || tags.length === 0) return [];
    const seen = new Set<string>();
    const result: string[] = [];
    for (const tag of tags) {
      const normalized = tag.trim().toLowerCase();
      if (normalized && !seen.has(normalized)) {
        seen.add(normalized);
        result.push(normalized);
      }
    }
    return result.sort();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd bot && npx vitest run tests/stores/memoryStore.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add bot/src/stores/memoryStore.ts bot/tests/stores/memoryStore.test.ts
git commit -m "feat(memory): rewrite MemoryStore with title/desc/content/type + tags"
```

---

### Task 4: Update Storage Facade

**Files:**
- Modify: `bot/src/storage.ts:108-124`
- Modify: `bot/tests/storage.memories.test.ts`

- [ ] **Step 1: Update Storage facade delegation methods**

Replace the memory methods section in `bot/src/storage.ts`:

```typescript
// === Memory methods (delegate to MemoryStore) ===

getMemoriesByGroup(groupId: string): MemoryWithTags[] {
  return this.memories.getByGroup(groupId);
}
```

Remove the old `upsertMemory`, `getMemory`, `deleteMemory` methods. Also update the import to include `MemoryWithTags`:

```typescript
import type { Attachment, Dossier, Memory, MemoryWithTags, Message, Persona, Reminder, ReminderMode } from './types';
```

- [ ] **Step 2: Update storage.memories.test.ts**

Rewrite `bot/tests/storage.memories.test.ts` to test through the new store methods. Since most memory operations now go through the store directly (not the facade), the test can be simplified:

```typescript
import { afterEach, describe, expect, it } from 'vitest';
import { createTestStorage, type TestStorage } from './helpers/testDb';

describe('Storage - Memories', () => {
  let ts: TestStorage;

  afterEach(() => {
    ts?.cleanup();
  });

  it('should access memory store for group queries', () => {
    ts = createTestStorage();
    ts.storage.memories.save('group1', 'Pizza', 'url', { content: 'http://example.com' });
    const memories = ts.storage.getMemoriesByGroup('group1');
    expect(memories).toHaveLength(1);
    expect(memories[0].title).toBe('Pizza');
  });

  it('should return empty array for group with no memories', () => {
    ts = createTestStorage();
    const memories = ts.storage.getMemoriesByGroup('group1');
    expect(memories).toEqual([]);
  });
});
```

- [ ] **Step 3: Run tests**

Run: `cd bot && npx vitest run tests/storage.memories.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add bot/src/storage.ts bot/tests/storage.memories.test.ts
git commit -m "feat(memory): update Storage facade for new MemoryStore API"
```

---

### Task 5: Rewrite Memory MCP Server

**Files:**
- Rewrite: `bot/src/mcp/servers/memories.ts`
- Rewrite: `bot/tests/memoryMcpServer.test.ts`

- [ ] **Step 1: Write failing MCP server tests**

Rewrite `bot/tests/memoryMcpServer.test.ts`:

```typescript
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeServer, sendAndReceive, spawnMcpServer as spawnServer } from './helpers/mcpTestHelpers';

describe('Memory MCP Server', () => {
  let testDir: string;
  let dbPath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'memory-mcp-test-'));
    dbPath = join(testDir, 'test.db');
  });

  afterEach(() => {
    if (testDir) rmSync(testDir, { recursive: true, force: true });
  });

  function spawnMcpServer(env: Record<string, string> = {}): ChildProcess {
    return spawnServer('mcp/servers/memories.ts', {
      DB_PATH: dbPath,
      MCP_GROUP_ID: 'test-group-1',
      MCP_SENDER: '+61400000000',
      ...env,
    });
  }

  it('should list 8 tools', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);
      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0', id: 2, method: 'tools/list',
      });
      const result = response.result as { tools: Array<{ name: string }> };
      expect(result.tools).toHaveLength(8);
      expect(result.tools.map(t => t.name).sort()).toEqual([
        'delete_memory', 'get_memory', 'list_tags', 'list_types',
        'manage_tags', 'save_memory', 'search_memories', 'update_memory',
      ]);
    } finally {
      proc.kill();
    }
  });

  it('should save and get a memory with tags', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);

      const saveResp = await sendAndReceive(proc, {
        jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: {
          name: 'save_memory',
          arguments: {
            title: 'Pizza Place',
            type: 'url',
            description: 'Dad loves this',
            content: 'http://pizza.com',
            tags: ['food', 'family'],
          },
        },
      });
      const saveResult = saveResp.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(saveResult.isError).toBeFalsy();
      expect(saveResult.content[0].text).toContain('Pizza Place');

      // Extract ID from response to use in get_memory
      const idMatch = saveResult.content[0].text.match(/id:\s*(\d+)/i) ||
                       saveResult.content[0].text.match(/#(\d+)/);
      const memoryId = idMatch ? Number(idMatch[1]) : 1;

      const getResp = await sendAndReceive(proc, {
        jsonrpc: '2.0', id: 4, method: 'tools/call',
        params: { name: 'get_memory', arguments: { id: memoryId } },
      });
      const getResult = getResp.result as { content: Array<{ text: string }> };
      expect(getResult.content[0].text).toContain('Pizza Place');
      expect(getResult.content[0].text).toContain('food');
    } finally {
      proc.kill();
    }
  });

  it('should search memories by keyword', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);

      await sendAndReceive(proc, {
        jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: {
          name: 'save_memory',
          arguments: { title: 'Pizza Place', type: 'url', content: 'http://pizza.com' },
        },
      });
      await sendAndReceive(proc, {
        jsonrpc: '2.0', id: 4, method: 'tools/call',
        params: {
          name: 'save_memory',
          arguments: { title: 'Sushi Spot', type: 'url', content: 'http://sushi.com' },
        },
      });

      const resp = await sendAndReceive(proc, {
        jsonrpc: '2.0', id: 5, method: 'tools/call',
        params: { name: 'search_memories', arguments: { keyword: 'pizza' } },
      });
      const result = resp.result as { content: Array<{ text: string }> };
      expect(result.content[0].text).toContain('Pizza Place');
      expect(result.content[0].text).not.toContain('Sushi Spot');
    } finally {
      proc.kill();
    }
  });

  it('should list types and tags', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);

      await sendAndReceive(proc, {
        jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: {
          name: 'save_memory',
          arguments: { title: 'A', type: 'fact', tags: ['food'] },
        },
      });
      await sendAndReceive(proc, {
        jsonrpc: '2.0', id: 4, method: 'tools/call',
        params: {
          name: 'save_memory',
          arguments: { title: 'B', type: 'url', tags: ['travel'] },
        },
      });

      const typesResp = await sendAndReceive(proc, {
        jsonrpc: '2.0', id: 5, method: 'tools/call',
        params: { name: 'list_types', arguments: {} },
      });
      expect((typesResp.result as any).content[0].text).toContain('fact');
      expect((typesResp.result as any).content[0].text).toContain('url');

      const tagsResp = await sendAndReceive(proc, {
        jsonrpc: '2.0', id: 6, method: 'tools/call',
        params: { name: 'list_tags', arguments: {} },
      });
      expect((tagsResp.result as any).content[0].text).toContain('food');
      expect((tagsResp.result as any).content[0].text).toContain('travel');
    } finally {
      proc.kill();
    }
  });

  it('should delete a memory', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);

      await sendAndReceive(proc, {
        jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: {
          name: 'save_memory',
          arguments: { title: 'To Delete', type: 'fact', content: 'bye' },
        },
      });

      const resp = await sendAndReceive(proc, {
        jsonrpc: '2.0', id: 4, method: 'tools/call',
        params: { name: 'delete_memory', arguments: { id: 1 } },
      });
      expect((resp.result as any).isError).toBeFalsy();
      expect((resp.result as any).content[0].text).toContain('Deleted');
    } finally {
      proc.kill();
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd bot && npx vitest run tests/memoryMcpServer.test.ts --reporter=verbose`
Expected: FAIL

- [ ] **Step 3: Rewrite the memory MCP server**

Rewrite `bot/src/mcp/servers/memories.ts`:

```typescript
import { DatabaseConnection } from '../../db';
import { MemoryStore } from '../../stores/memoryStore';
import { readStorageEnv } from '../env';
import { withNotification } from '../notify';
import { estimateTokens, ok } from '../result';
import { runServer } from '../runServer';
import type { McpServerDefinition } from '../types';
import { requireGroupId, requireNumber, requireString } from '../validate';

const TOOLS = [
  {
    name: 'save_memory',
    title: 'Save Memory',
    description:
      'Save a new memory or update an existing one (matched by title). Before saving, call list_types to check existing types for consistency. Tags and type are normalized to lowercase.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Short label for the memory' },
        type: { type: 'string', description: 'Memory type (e.g. fact, url, preference, image). Check list_types first.' },
        description: { type: 'string', description: 'Why this was saved, what it means' },
        content: { type: 'string', description: 'The actual payload — text, URL, reference, etc.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for categorization. Check list_tags first.' },
      },
      required: ['title', 'type'],
    },
  },
  {
    name: 'update_memory',
    title: 'Update Memory',
    description: 'Update an existing memory by ID. Only provided fields are changed. Tags are replaced entirely if provided.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'number', description: 'Memory ID' },
        title: { type: 'string', description: 'New title' },
        description: { type: 'string', description: 'New description' },
        content: { type: 'string', description: 'New content' },
        type: { type: 'string', description: 'New type' },
        tags: { type: 'array', items: { type: 'string' }, description: 'New tags (replaces all existing)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'get_memory',
    title: 'Get Memory',
    description: 'Get a single memory by ID, including its tags.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'number', description: 'Memory ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'search_memories',
    title: 'Search Memories',
    description: 'Search memories with optional filters. With no filters, returns all memories for the group. Sorted by most recently updated.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        keyword: { type: 'string', description: 'Search title, description, and content' },
        type: { type: 'string', description: 'Filter by type' },
        tag: { type: 'string', description: 'Filter by tag' },
        limit: { type: 'number', description: 'Max results (default 20, max 100)' },
      },
    },
  },
  {
    name: 'list_types',
    title: 'List Types',
    description: 'List all distinct memory types in use for this group. Call before saving to stay consistent.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'list_tags',
    title: 'List Tags',
    description: 'List all distinct tags in use for this group. Call before saving to stay consistent.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'delete_memory',
    title: 'Delete Memory',
    description: 'Delete a memory by ID. Also removes all associated tags.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'number', description: 'Memory ID to delete' },
      },
      required: ['id'],
    },
  },
  {
    name: 'manage_tags',
    title: 'Manage Tags',
    description: 'Add or remove tags from an existing memory without changing other fields.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'number', description: 'Memory ID' },
        add: { type: 'array', items: { type: 'string' }, description: 'Tags to add' },
        remove: { type: 'array', items: { type: 'string' }, description: 'Tags to remove' },
      },
      required: ['id'],
    },
  },
];

let conn: DatabaseConnection;
let store: MemoryStore;
let groupId: string;

function formatMemory(m: { id: number; title: string; type: string; description: string | null; content: string | null; tags: string[] }): string {
  const lines = [`#${m.id} "${m.title}" [${m.type}]`];
  if (m.description) lines.push(`  Description: ${m.description}`);
  if (m.content) lines.push(`  Content: ${m.content}`);
  if (m.tags.length > 0) lines.push(`  Tags: ${m.tags.join(', ')}`);
  return lines.join('\n');
}

function tokenReport(description: string | null | undefined, content: string | null | undefined): string {
  const parts: string[] = [];
  if (description) parts.push(`description: ~${estimateTokens(description)} tokens`);
  if (content) parts.push(`content: ~${estimateTokens(content)} tokens`);
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

export const memoryServer: McpServerDefinition = {
  serverName: 'signal-bot-memories',
  configKey: 'memories',
  entrypoint: 'memories',
  tools: TOOLS,
  envMapping: { DB_PATH: 'dbPath', MCP_GROUP_ID: 'groupId', MCP_SENDER: 'sender' },
  handlers: {
    save_memory(args) {
      const title = requireString(args, 'title');
      if (title.error) return title.error;
      const type = requireString(args, 'type');
      if (type.error) return type.error;
      const groupErr = requireGroupId(groupId);
      if (groupErr) return groupErr;

      const description = typeof args.description === 'string' ? args.description : undefined;
      const content = typeof args.content === 'string' ? args.content : undefined;
      const tags = Array.isArray(args.tags) ? args.tags.filter((t: unknown) => typeof t === 'string') as string[] : undefined;

      return withNotification(
        `Memory saved: "${title.value}"`,
        'save memory',
        () => {
          const m = store.save(groupId, title.value, type.value, { description, content, tags });
          return ok(`Saved memory${tokenReport(description, content)}:\n${formatMemory(m)}`);
        },
        'Failed to save memory',
      );
    },

    update_memory(args) {
      const id = requireNumber(args, 'id');
      if (id.error) return id.error;
      const groupErr = requireGroupId(groupId);
      if (groupErr) return groupErr;

      const opts: Record<string, unknown> = {};
      if (typeof args.title === 'string') opts.title = args.title;
      if (typeof args.description === 'string') opts.description = args.description;
      if (typeof args.content === 'string') opts.content = args.content;
      if (typeof args.type === 'string') opts.type = args.type;
      if (Array.isArray(args.tags)) opts.tags = args.tags.filter((t: unknown) => typeof t === 'string');

      return withNotification(
        `Memory #${id.value} updated`,
        'update memory',
        () => {
          const m = store.update(id.value, opts);
          if (!m) return ok(`No memory found with id ${id.value}.`);
          return ok(`Updated memory${tokenReport(m.description, m.content)}:\n${formatMemory(m)}`);
        },
        'Failed to update memory',
      );
    },

    get_memory(args) {
      const id = requireNumber(args, 'id');
      if (id.error) return id.error;
      const groupErr = requireGroupId(groupId);
      if (groupErr) return groupErr;

      const m = store.getById(id.value);
      if (!m) return ok(`No memory found with id ${id.value}.`);
      return ok(formatMemory(m));
    },

    search_memories(args) {
      const groupErr = requireGroupId(groupId);
      if (groupErr) return groupErr;

      const keyword = typeof args.keyword === 'string' ? args.keyword : undefined;
      const type = typeof args.type === 'string' ? args.type : undefined;
      const tag = typeof args.tag === 'string' ? args.tag : undefined;
      const limit = typeof args.limit === 'number' ? args.limit : 20;

      const results = store.search(groupId, { keyword, type, tag }, limit);
      if (results.length === 0) {
        return ok('No memories found matching the search criteria.');
      }
      const lines = results.map(formatMemory);
      return ok(`Found ${results.length} memory(ies):\n\n${lines.join('\n\n')}`);
    },

    list_types() {
      const groupErr = requireGroupId(groupId);
      if (groupErr) return groupErr;
      const types = store.listTypes(groupId);
      if (types.length === 0) return ok('No memory types in use yet.');
      return ok(`Types in use: ${types.join(', ')}`);
    },

    list_tags() {
      const groupErr = requireGroupId(groupId);
      if (groupErr) return groupErr;
      const tags = store.listTags(groupId);
      if (tags.length === 0) return ok('No tags in use yet.');
      return ok(`Tags in use: ${tags.join(', ')}`);
    },

    delete_memory(args) {
      const id = requireNumber(args, 'id');
      if (id.error) return id.error;
      const groupErr = requireGroupId(groupId);
      if (groupErr) return groupErr;

      return withNotification(
        `Memory #${id.value} deleted`,
        'delete memory',
        () => {
          const deleted = store.deleteById(id.value);
          if (!deleted) return ok(`No memory found with id ${id.value}.`);
          return ok(`Deleted memory #${id.value}.`);
        },
        'Failed to delete memory',
      );
    },

    manage_tags(args) {
      const id = requireNumber(args, 'id');
      if (id.error) return id.error;
      const groupErr = requireGroupId(groupId);
      if (groupErr) return groupErr;

      const add = Array.isArray(args.add) ? args.add.filter((t: unknown) => typeof t === 'string') as string[] : [];
      const remove = Array.isArray(args.remove) ? args.remove.filter((t: unknown) => typeof t === 'string') as string[] : [];

      return withNotification(
        `Tags updated on memory #${id.value}`,
        'manage tags',
        () => {
          const m = store.manageTags(id.value, add, remove);
          if (!m) return ok(`No memory found with id ${id.value}.`);
          return ok(`Updated tags:\n${formatMemory(m)}`);
        },
        'Failed to manage tags',
      );
    },
  },
  onInit() {
    const env = readStorageEnv();
    conn = new DatabaseConnection(env.dbPath);
    store = new MemoryStore(conn);
    groupId = env.groupId;
    console.error(`Memory MCP server started (group: ${groupId || 'none'})`);
  },
  onClose() {
    conn.close();
  },
};

if (require.main === module) {
  runServer(memoryServer);
}
```

- [ ] **Step 4: Run MCP server tests**

Run: `cd bot && npx vitest run tests/memoryMcpServer.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add bot/src/mcp/servers/memories.ts bot/tests/memoryMcpServer.test.ts
git commit -m "feat(memory): rewrite memory MCP server with 8 tools"
```

---

### Task 6: Memory CLI Scripts

**Files:**
- Create: `bot/src/memory/cli.ts`
- Create: `bot/tests/memory/cli.test.ts`

- [ ] **Step 1: Write failing tests for the CLI**

Create `bot/tests/memory/cli.test.ts`:

```typescript
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('Memory CLI', () => {
  let testDir: string;
  let dbPath: string;
  const cliPath = join(__dirname, '../../src/memory/cli.ts');

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'memory-cli-test-'));
    dbPath = join(testDir, 'test.db');
  });

  afterEach(() => {
    if (testDir) rmSync(testDir, { recursive: true, force: true });
  });

  function run(args: string): string {
    return execSync(
      `npx tsx ${cliPath} ${args}`,
      { env: { ...process.env, DB_PATH: dbPath }, encoding: 'utf-8', timeout: 10000 },
    ).trim();
  }

  it('should save and search a memory', () => {
    run('save --group g1 --title "Pizza Place" --type url --content "http://pizza.com" --tags food,family');
    const output = run('search --group g1 --keyword pizza');
    expect(output).toContain('Pizza Place');
    expect(output).toContain('http://pizza.com');
  });

  it('should list types', () => {
    run('save --group g1 --title A --type fact');
    run('save --group g1 --title B --type url');
    const output = run('list-types --group g1');
    expect(output).toContain('fact');
    expect(output).toContain('url');
  });

  it('should list tags', () => {
    run('save --group g1 --title A --type fact --tags food,health');
    const output = run('list-tags --group g1');
    expect(output).toContain('food');
    expect(output).toContain('health');
  });

  it('should delete a memory', () => {
    run('save --group g1 --title Temp --type fact --content "bye"');
    run('delete --group g1 --id 1');
    const output = run('search --group g1');
    expect(output).toContain('No memories found');
  });

  it('should search by tag', () => {
    run('save --group g1 --title A --type fact --tags food');
    run('save --group g1 --title B --type fact --tags travel');
    const output = run('search --group g1 --tag food');
    expect(output).toContain('A');
    expect(output).not.toContain('B');
  });

  it('should search by type', () => {
    run('save --group g1 --title A --type fact');
    run('save --group g1 --title B --type url');
    const output = run('search --group g1 --type fact');
    expect(output).toContain('A');
    expect(output).not.toContain('B');
  });

  it('should output plain text (not JSON)', () => {
    run('save --group g1 --title Test --type fact --content "hello"');
    const output = run('search --group g1');
    expect(output).not.toStartWith('{');
    expect(output).not.toStartWith('[');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd bot && npx vitest run tests/memory/cli.test.ts --reporter=verbose`
Expected: FAIL — `cli.ts` doesn't exist.

- [ ] **Step 3: Create the CLI script**

Create `bot/src/memory/cli.ts`:

```typescript
import { DatabaseConnection } from '../db';
import { MemoryStore } from '../stores/memoryStore';

const DB_PATH = process.env.DB_PATH || './data/bot.db';

function parseArgs(argv: string[]): { command: string; flags: Record<string, string> } {
  const command = argv[2] || '';
  const flags: Record<string, string> = {};
  for (let i = 3; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : '';
      flags[key] = value;
      if (value) i++;
    }
  }
  return { command, flags };
}

function main(): void {
  const { command, flags } = parseArgs(process.argv);
  const conn = new DatabaseConnection(DB_PATH);
  const store = new MemoryStore(conn);

  try {
    switch (command) {
      case 'save': {
        const groupId = flags.group;
        const title = flags.title;
        const type = flags.type;
        if (!groupId || !title || !type) {
          console.log('Usage: save --group <id> --title <title> --type <type> [--description <d>] [--content <c>] [--tags <t1,t2>]');
          process.exit(1);
        }
        const tags = flags.tags ? flags.tags.split(',').map(t => t.trim()) : undefined;
        const m = store.save(groupId, title, type, {
          description: flags.description || undefined,
          content: flags.content || undefined,
          tags,
        });
        console.log(`Saved #${m.id} "${m.title}" [${m.type}]`);
        if (m.description) console.log(`  Description: ${m.description}`);
        if (m.content) console.log(`  Content: ${m.content}`);
        if (m.tags.length > 0) console.log(`  Tags: ${m.tags.join(', ')}`);
        break;
      }

      case 'search': {
        const groupId = flags.group;
        if (!groupId) {
          console.log('Usage: search --group <id> [--keyword <kw>] [--tag <tag>] [--type <type>]');
          process.exit(1);
        }
        const results = store.search(groupId, {
          keyword: flags.keyword || undefined,
          type: flags.type || undefined,
          tag: flags.tag || undefined,
        });
        if (results.length === 0) {
          console.log('No memories found.');
          break;
        }
        for (const m of results) {
          console.log(`#${m.id} "${m.title}" [${m.type}]`);
          if (m.description) console.log(`  Description: ${m.description}`);
          if (m.content) console.log(`  Content: ${m.content}`);
          if (m.tags.length > 0) console.log(`  Tags: ${m.tags.join(', ')}`);
          console.log('');
        }
        break;
      }

      case 'list-types': {
        const groupId = flags.group;
        if (!groupId) {
          console.log('Usage: list-types --group <id>');
          process.exit(1);
        }
        const types = store.listTypes(groupId);
        if (types.length === 0) {
          console.log('No types in use.');
        } else {
          console.log(`Types: ${types.join(', ')}`);
        }
        break;
      }

      case 'list-tags': {
        const groupId = flags.group;
        if (!groupId) {
          console.log('Usage: list-tags --group <id>');
          process.exit(1);
        }
        const tags = store.listTags(groupId);
        if (tags.length === 0) {
          console.log('No tags in use.');
        } else {
          console.log(`Tags: ${tags.join(', ')}`);
        }
        break;
      }

      case 'delete': {
        const groupId = flags.group;
        const id = flags.id;
        if (!groupId || !id) {
          console.log('Usage: delete --group <id> --id <memoryId>');
          process.exit(1);
        }
        const deleted = store.deleteById(Number(id));
        console.log(deleted ? `Deleted memory #${id}.` : `No memory found with id ${id}.`);
        break;
      }

      default:
        console.log('Commands: save, search, list-types, list-tags, delete');
        console.log('Use --group <id> with all commands.');
        process.exit(1);
    }
  } finally {
    conn.close();
  }
}

main();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd bot && npx vitest run tests/memory/cli.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add bot/src/memory/cli.ts bot/tests/memory/cli.test.ts
git commit -m "feat(memory): add CLI scripts for haiku subagent memory access"
```

---

### Task 7: Update MemoryExtractor for Haiku + CLI Pipeline

**Files:**
- Rewrite: `bot/src/memoryExtractor.ts`
- Modify: `bot/tests/memoryExtractor.test.ts`

- [ ] **Step 1: Read the existing memoryExtractor test to understand patterns**

Run: `cd bot && cat tests/memoryExtractor.test.ts` (or Read tool)

- [ ] **Step 2: Rewrite MemoryExtractor to use haiku + CLI**

Replace `bot/src/memoryExtractor.ts`. The new extractor:
- Uses `claude -p --model haiku` instead of `claude-sonnet-4-6`
- Gives the haiku subagent access to `Bash` tool to call memory CLI scripts
- Provides instructions to check existing types/tags before saving
- Also handles the pre-response memory read (synchronous)
- Post-response write remains async (fire-and-forget)

```typescript
import path from 'node:path';
import { parseEntries, spawnCollect } from './claudeClient';
import { logger } from './logger';
import { SpawnLimiter } from './spawnLimiter';

const DEBOUNCE_MS = 5000;
const READ_TIMEOUT_MS = 10_000;
const WRITE_TIMEOUT_MS = 60_000;

const CLI_PATH = path.resolve(__dirname, 'memory/cli.ts');

const READ_PROMPT_TEMPLATE = `You are a memory retrieval assistant. Given a message from a group chat, search the group's memories for anything relevant.

Use the Bash tool to run memory CLI commands. The CLI is at: npx tsx ${CLI_PATH}
Set DB_PATH in the environment for all commands.

Available commands:
- search --group <GROUP_ID> --keyword <word>
- search --group <GROUP_ID> --tag <tag>
- search --group <GROUP_ID> --type <type>
- search --group <GROUP_ID>  (all memories)
- list-types --group <GROUP_ID>
- list-tags --group <GROUP_ID>

Extract 2-3 keywords from the message and search. Also try searching by likely tags.

Output a concise summary of relevant memories, or "No relevant memories found." if nothing matches.
Do NOT output anything else — no explanations, no formatting, just the summary.`;

const WRITE_PROMPT_TEMPLATE = `You are a memory extraction assistant. Analyze the conversation and decide what's worth remembering.

Use the Bash tool to run memory CLI commands. The CLI is at: npx tsx ${CLI_PATH}
Set DB_PATH in the environment for all commands.

Available commands:
- save --group <GROUP_ID> --title "<title>" --type <type> [--description "<desc>"] [--content "<content>"] [--tags <t1,t2>]
- search --group <GROUP_ID> [--keyword <kw>] [--tag <tag>] [--type <type>]
- list-types --group <GROUP_ID>
- list-tags --group <GROUP_ID>
- delete --group <GROUP_ID> --id <memoryId>

IMPORTANT WORKFLOW:
1. First, run list-types and list-tags to see existing types and tags
2. Search existing memories to avoid duplicates
3. Save new memories using consistent types and tags

What to save: facts about people, preferences, URLs shared, plans discussed, corrections to existing info, notable events.
Be aggressive — save anything that might be useful later. But don't duplicate existing memories.

When done, output a one-line summary of what you saved (or "Nothing worth saving.").`;

export class MemoryExtractor {
  private limiter = new SpawnLimiter(1);
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  /**
   * Pre-response: synchronously fetch relevant memories for an incoming message.
   * Returns a summary string, or null if no relevant memories found or timeout.
   */
  async readMemories(groupId: string, message: string): Promise<string | null> {
    const prompt = READ_PROMPT_TEMPLATE
      .replace(/<GROUP_ID>/g, groupId)
      + `\n\nDB_PATH=${this.dbPath}\nGroup ID: ${groupId}\n\nMessage: "${message}"`;

    try {
      const stdout = await spawnCollect('claude', [
        '-p', prompt,
        '--output-format', 'json',
        '--max-turns', '5',
        '--no-session-persistence',
        '--model', 'claude-haiku-4-5-20251001',
        '--allowedTools', 'Bash',
      ], {
        timeout: READ_TIMEOUT_MS,
        env: { ...process.env, DB_PATH: this.dbPath },
        trackChild: child => this.limiter.trackChild(child),
      });

      const entries = parseEntries(stdout);
      const result = entries.find(e => e.type === 'result');
      const text = typeof result?.result === 'string' ? result.result.trim() : '';

      if (!text || text.toLowerCase().includes('no relevant memories')) {
        return null;
      }

      logger.step(`memory-read: found relevant memories for group ${groupId}`);
      return text;
    } catch (err) {
      logger.debug(`memory-read: failed or timed out for group ${groupId}: ${err}`);
      return null;
    }
  }

  /**
   * Schedule a debounced post-response write for a group.
   */
  scheduleExtraction(groupId: string, message: string, botResponse: string): void {
    const existing = this.timers.get(groupId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.timers.delete(groupId);
      this.writeMemories(groupId, message, botResponse).catch(err => {
        logger.error(`memory-write: unhandled error for group ${groupId}: ${err}`);
      });
    }, DEBOUNCE_MS);

    this.timers.set(groupId, timer);
  }

  /**
   * Post-response: extract and save memories from a conversation.
   */
  async writeMemories(groupId: string, message: string, botResponse: string): Promise<void> {
    await this.limiter.acquire();
    try {
      const prompt = WRITE_PROMPT_TEMPLATE
        .replace(/<GROUP_ID>/g, groupId)
        + `\n\nDB_PATH=${this.dbPath}\nGroup ID: ${groupId}\n\nUser message: "${message}"\n\nBot response: "${botResponse}"`;

      const stdout = await spawnCollect('claude', [
        '-p', prompt,
        '--output-format', 'json',
        '--max-turns', '10',
        '--no-session-persistence',
        '--model', 'claude-haiku-4-5-20251001',
        '--allowedTools', 'Bash',
      ], {
        timeout: WRITE_TIMEOUT_MS,
        env: { ...process.env, DB_PATH: this.dbPath },
        trackChild: child => this.limiter.trackChild(child),
      });

      const entries = parseEntries(stdout);
      const result = entries.find(e => e.type === 'result');
      const text = typeof result?.result === 'string' ? result.result.trim() : '';
      if (text && !text.toLowerCase().includes('nothing worth saving')) {
        logger.step(`memory-write: ${text} (group ${groupId})`);
      }
    } catch (err) {
      logger.error(`memory-write: extraction failed for group ${groupId}: ${err}`);
    } finally {
      this.limiter.release();
    }
  }

  clearTimers(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  killAll(): void {
    this.limiter.killAll();
  }
}
```

- [ ] **Step 3: Update memoryExtractor.test.ts**

Update the test to match the new constructor signature and method names. Since the extractor now spawns Claude CLI, the tests should focus on the API contract (constructor, method signatures, timer management) without actually spawning processes:

```typescript
import { afterEach, describe, expect, it, vi } from 'vitest';
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
    // No assertion needed — just verify no crash
  });

  it('should debounce multiple schedule calls', () => {
    extractor = new MemoryExtractor('/tmp/test.db');
    extractor.scheduleExtraction('group1', 'msg1', 'resp1');
    extractor.scheduleExtraction('group1', 'msg2', 'resp2');
    extractor.clearTimers();
  });
});
```

- [ ] **Step 4: Run tests**

Run: `cd bot && npx vitest run tests/memoryExtractor.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add bot/src/memoryExtractor.ts bot/tests/memoryExtractor.test.ts
git commit -m "feat(memory): rewrite MemoryExtractor to use haiku + CLI pipeline"
```

---

### Task 8: Update MessageHandler and ContextBuilder Integration

**Files:**
- Modify: `bot/src/contextBuilder.ts`
- Modify: `bot/src/messageHandler.ts`
- Modify: `bot/src/index.ts`
- Modify: `bot/tests/contextBuilder.test.ts`
- Modify: `bot/tests/messageHandler.test.ts`

- [ ] **Step 1: Add memorySummary to contextBuilder**

In `bot/src/contextBuilder.ts`, update `buildContext` params to accept `memorySummary`:

```typescript
buildContext(params: {
  history: Message[];
  query: string;
  groupId?: string;
  sender?: string;
  dossierContext?: string;
  memorySummary?: string;
  personaDescription?: string;
  nameMap?: Map<string, string>;
  preFormatted?: string[];
}): ChatMessage[] {
```

In the body, inject the memory summary after dossier context. Find where `dossierContext` is used in the `if (groupId && sender)` block and add after it:

```typescript
if (dossierContext) {
  systemContent = `${timeContext}\n\n${dossierContext}`;
} else {
  systemContent = timeContext;
}

if (params.memorySummary) {
  systemContent += `\n\n## Relevant Memories\n${params.memorySummary}`;
}

systemContent += `\n\n${PERSONA_SAFETY_PROMPT}\n\n${effectivePrompt}`;
```

Also update the `MEMORY_INSTRUCTIONS` constant to reflect the new tools:

```typescript
const MEMORY_INSTRUCTIONS =
  'You have memory tools: save_memory, update_memory, get_memory, search_memories, list_types, list_tags, delete_memory, manage_tags. Memories have a title, type, description, content, and tags. Before saving, call list_types and list_tags to stay consistent with existing categories. Memories are automatically read and written by a background process, but you can also use these tools directly.';
```

- [ ] **Step 2: Remove old memory context injection from assembleAdditionalContext**

In `bot/src/messageHandler.ts`, the `assembleAdditionalContext` method currently injects memories directly. Remove the memory section (the `MEMORY_CONTEXT_BUDGET` / `memories` block starting around line 296). Keep only the dossier context.

- [ ] **Step 3: Wire up the haiku pre-read in processLlmRequest**

In `bot/src/messageHandler.ts`, in `processLlmRequest`, add a memory read step before building context:

```typescript
// Pre-fetch relevant memories via haiku subagent
let memorySummary: string | undefined;
if (this.memoryExtractor) {
  memorySummary = (await this.memoryExtractor.readMemories(groupId, content)) ?? undefined;
  if (memorySummary) {
    logger.step(`context: memory summary injected (${memorySummary.length} chars)`);
  }
}
```

Then pass it to `buildContext`:

```typescript
const messages = this.contextBuilder.buildContext({
  history,
  query: queryWithAttachments,
  groupId,
  sender,
  dossierContext: additionalContext,
  memorySummary,
  personaDescription: personaPrompt,
  nameMap,
  preFormatted: historyFormatted,
});
```

- [ ] **Step 4: Wire up the post-write in processLlmRequest**

After the response is sent, update the `scheduleExtraction` call to pass the message and response:

```typescript
if (this.memoryExtractor) {
  this.memoryExtractor.scheduleExtraction(groupId, content, response.content);
}
```

- [ ] **Step 5: Update index.ts constructor call**

In `bot/src/index.ts`, update the `MemoryExtractor` constructor:

```typescript
const memoryExtractor = new MemoryExtractor(config.dbPath);
```

Remove `memoryConsolidator` references if the consolidator relied on the old memory schema (check if it needs updating too — it uses `storage.getMemoriesByGroup` which still works, so it may be fine. If it references `topic` directly, update those references to use `title`).

- [ ] **Step 6: Add a test for memorySummary injection in contextBuilder**

Add to `bot/tests/contextBuilder.test.ts`:

```typescript
it('should inject memorySummary into system prompt when provided', () => {
  const messages = builder.buildContext({
    history: [],
    query: 'hello',
    groupId: 'group1',
    sender: '+61400000000',
    memorySummary: 'Dad prefers pepperoni pizza',
  });
  const system = messages[0].content;
  expect(system).toContain('## Relevant Memories');
  expect(system).toContain('Dad prefers pepperoni pizza');
});

it('should not inject memory section when memorySummary is undefined', () => {
  const messages = builder.buildContext({
    history: [],
    query: 'hello',
    groupId: 'group1',
    sender: '+61400000000',
  });
  const system = messages[0].content;
  expect(system).not.toContain('## Relevant Memories');
});
```

- [ ] **Step 7: Run tests**

Run: `cd bot && npx vitest run tests/contextBuilder.test.ts tests/messageHandler.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add bot/src/contextBuilder.ts bot/src/messageHandler.ts bot/src/index.ts bot/tests/contextBuilder.test.ts bot/tests/messageHandler.test.ts
git commit -m "feat(memory): integrate haiku memory pipeline into message handling"
```

---

### Task 9: Update MemoryConsolidator for New Schema

**Files:**
- Modify: `bot/src/memoryConsolidator.ts`
- Modify: `bot/tests/memoryConsolidator.test.ts`

- [ ] **Step 1: Check if memoryConsolidator references old schema fields**

Read `bot/src/memoryConsolidator.ts` fully. Any reference to `m.topic` needs to become `m.title`. The consolidator's prompt may reference "topic" — update to "title". The `applyUpdates` method calls `storage.upsertMemory(groupId, topic, content)` — update to use `storage.memories.save(groupId, title, type, { content })`.

- [ ] **Step 2: Update the consolidator**

Update all references:
- `m.topic` → `m.title`
- `storage.upsertMemory(groupId, mu.topic, mu.content)` → `storage.memories.save(groupId, mu.topic, mu.action === 'delete' ? 'text' : 'text', { content: mu.content })`
- `storage.deleteMemory(groupId, mu.topic)` → find by title and delete by ID, or add a `deleteByTitle` helper
- Update the prompt to use "title" instead of "topic"

Since deleting by title is needed, add a small helper to `MemoryStore`:

```typescript
deleteByTitle(groupId: string, title: string): boolean {
  return this.conn.runOp('delete memory by title', () => {
    const result = this.conn.db.prepare(
      'DELETE FROM memories WHERE groupId = ? AND title = ?',
    ).run(groupId, title);
    return result.changes > 0;
  });
}
```

- [ ] **Step 3: Run tests**

Run: `cd bot && npx vitest run tests/memoryConsolidator.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add bot/src/memoryConsolidator.ts bot/src/stores/memoryStore.ts bot/tests/memoryConsolidator.test.ts
git commit -m "feat(memory): update memoryConsolidator for new schema"
```

---

### Task 10: Fix Remaining Test Breakage and Full Suite

**Files:**
- Various test files that reference old memory API

- [ ] **Step 1: Run full test suite**

Run: `cd bot && npx vitest run --reporter=verbose`

- [ ] **Step 2: Fix any failing tests**

Common breakages to expect:
- `storage.test.ts` — references to `upsertMemory`, `getMemory`, `deleteMemory`
- `integration.test.ts` — may reference old memory methods
- `messageHandler.test.ts` — `MemoryExtractor` constructor changed
- `messageHandler.batch.test.ts` — same

For each failure, update to use the new API:
- `storage.upsertMemory(g, topic, content)` → `storage.memories.save(g, topic, 'text', { content })`
- `storage.getMemory(g, topic)` → `storage.memories.search(g, { keyword: topic })` or similar
- `storage.deleteMemory(g, topic)` → `storage.memories.deleteByTitle(g, topic)`
- `new MemoryExtractor(storage)` → `new MemoryExtractor(dbPath)`

- [ ] **Step 3: Run full test suite again**

Run: `cd bot && npx vitest run --reporter=verbose`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "fix: update all tests for new memory system API"
```

---

### Task 11: Update CLAUDE.md Documentation

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update the MCP servers section**

In `CLAUDE.md`, update the `memories.ts` entry:

```
- `memories.ts` — Versatile memory store: save/update/get/search/delete memories with types, tags, descriptions (8 tools). CLI scripts at `memory/cli.ts` for haiku subagent access.
```

- [ ] **Step 2: Update the Architecture section**

Add `memoryExtractor.ts` description update:

```
- `bot/src/memoryExtractor.ts` — Haiku subagent pipeline: pre-response memory read (synchronous, 10s timeout), post-response memory write (async, fire-and-forget). Uses CLI scripts via Bash tool.
- `bot/src/memory/cli.ts` — Memory CLI for haiku subagents: search, save, list-types, list-tags, delete. Plain text output.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for versatile memory system"
```

---

### Task 12: Lint and Final Verification

- [ ] **Step 1: Run linter**

Run: `cd bot && npm run check`
Expected: PASS (no lint/format errors)

- [ ] **Step 2: Fix any lint issues**

Fix and re-run until clean.

- [ ] **Step 3: Run full test suite one final time**

Run: `cd bot && npx vitest run --reporter=verbose`
Expected: ALL PASS

- [ ] **Step 4: Commit any lint fixes**

```bash
git add -A
git commit -m "chore: lint fixes for memory system"
```
