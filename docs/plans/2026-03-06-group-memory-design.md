# Group Memory System Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add persistent group memory so the bot retains facts, decisions, preferences, and recurring topics across conversations.

**Architecture:** Mirrors the existing dossier pattern exactly: SQLite store + MCP server + eager context injection. New `memories` table keyed by `(groupId, topic)`, a `MemoryStore` class, an MCP server with 4 tools, and injection into the system prompt after dossiers.

**Tech Stack:** TypeScript, better-sqlite3, vitest, MCP JSON-RPC protocol

**Issue:** https://github.com/orbxom/signal-bot/issues/15

---

### Task 1: Add Memory type

**Files:**
- Modify: `bot/src/types.ts:39-47` (after `Dossier` interface)

**Step 1: Add the Memory interface**

Add after the `Dossier` interface (line 47):

```typescript
export interface Memory {
  id: number;
  groupId: string;
  topic: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}
```

**Step 2: Verify it compiles**

Run: `cd bot && npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add bot/src/types.ts
git commit -m "feat: add Memory type interface"
```

---

### Task 2: Add v2 database migration

**Files:**
- Modify: `bot/src/db.ts:120-131` (runMigrations method)
- Test: `bot/tests/db.test.ts`

**Step 1: Write the failing test**

Add to `bot/tests/db.test.ts` inside the `migrations` describe block:

```typescript
it('should create memories table in v2 migration', () => {
  const conn = new DatabaseConnection(createTestDb());
  try {
    const tables = conn.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(tables.map(t => t.name)).toContain('memories');
  } finally {
    conn.close();
  }
});

it('should create memories indexes in v2 migration', () => {
  const conn = new DatabaseConnection(createTestDb());
  try {
    const indexes = conn.db
      .prepare("SELECT name FROM sqlite_master WHERE type='index'")
      .all() as Array<{ name: string }>;
    const indexNames = indexes.map(i => i.name);
    expect(indexNames).toContain('idx_memories_group_topic');
    expect(indexNames).toContain('idx_memories_group');
  } finally {
    conn.close();
  }
});

it('should set schema version to 2 after migrations', () => {
  const conn = new DatabaseConnection(createTestDb());
  try {
    const row = conn.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as {
      value: string;
    };
    expect(Number.parseInt(row.value, 10)).toBe(2);
  } finally {
    conn.close();
  }
});
```

**Step 2: Run tests to verify they fail**

Run: `cd bot && npx vitest run tests/db.test.ts`
Expected: FAIL — `memories` table doesn't exist, schema version is still 1

**Step 3: Implement the v2 migration**

In `bot/src/db.ts`, add `migrateToV2()` method after `migrateToV1()`:

```typescript
private migrateToV2(): void {
  this.db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      groupId TEXT NOT NULL,
      topic TEXT NOT NULL,
      content TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_group_topic
    ON memories(groupId, topic);

    CREATE INDEX IF NOT EXISTS idx_memories_group
    ON memories(groupId);
  `);
}
```

Update `runMigrations()` to call it:

```typescript
private runMigrations(): void {
  try {
    const currentVersion = this.getSchemaVersion();

    if (currentVersion < 1) {
      this.migrateToV1();
      this.setSchemaVersion(1);
    }
    if (currentVersion < 2) {
      this.migrateToV2();
      this.setSchemaVersion(2);
    }
  } catch (error) {
    wrapSqliteError(error, 'run migrations');
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `cd bot && npx vitest run tests/db.test.ts`
Expected: ALL PASS

**Step 5: Update existing test that checks schema version >= 1**

The existing test `should track schema version in schema_meta table` checks `>= 1`. Update it to check `=== 2` or leave as-is (it still passes). No change needed — `>= 1` still holds.

**Step 6: Commit**

```bash
git add bot/src/db.ts bot/tests/db.test.ts
git commit -m "feat: add v2 migration for memories table"
```

---

### Task 3: Create MemoryStore

**Files:**
- Create: `bot/src/stores/memoryStore.ts`
- Create: `bot/tests/stores/memoryStore.test.ts`

**Step 1: Write the failing tests**

Create `bot/tests/stores/memoryStore.test.ts`:

```typescript
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseConnection } from '../../src/db';
import { MEMORY_TOKEN_LIMIT, MemoryStore } from '../../src/stores/memoryStore';

describe('MemoryStore', () => {
  let testDir: string;
  let conn: DatabaseConnection;
  let store: MemoryStore;

  const setup = () => {
    testDir = mkdtempSync(join(tmpdir(), 'signal-bot-memory-store-test-'));
    conn = new DatabaseConnection(join(testDir, 'test.db'));
    store = new MemoryStore(conn);
    return store;
  };

  afterEach(() => {
    conn?.close();
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('upsert', () => {
    it('should create a new memory', () => {
      setup();
      const memory = store.upsert('group1', 'holiday plans', 'Going to Byron Bay in April');
      expect(memory).toMatchObject({
        groupId: 'group1',
        topic: 'holiday plans',
        content: 'Going to Byron Bay in April',
      });
      expect(memory.id).toBeGreaterThan(0);
      expect(memory.createdAt).toBeGreaterThan(0);
      expect(memory.updatedAt).toBeGreaterThan(0);
    });

    it('should update an existing memory with same groupId and topic', () => {
      setup();
      const first = store.upsert('group1', 'holiday plans', 'Original');
      const second = store.upsert('group1', 'holiday plans', 'Updated');
      expect(second.id).toBe(first.id);
      expect(second.content).toBe('Updated');
    });

    it('should reject empty groupId', () => {
      setup();
      expect(() => store.upsert('', 'topic', 'content')).toThrow('Invalid groupId: cannot be empty');
    });

    it('should reject empty topic', () => {
      setup();
      expect(() => store.upsert('group1', '', 'content')).toThrow('Invalid topic: cannot be empty');
    });

    it('should reject content exceeding token limit', () => {
      setup();
      const longContent = 'a'.repeat(MEMORY_TOKEN_LIMIT * 4 + 1);
      expect(() => store.upsert('group1', 'topic', longContent)).toThrow('exceeds token limit');
    });

    it('should allow content at exactly the token limit', () => {
      setup();
      const exactContent = 'a'.repeat(MEMORY_TOKEN_LIMIT * 4);
      const memory = store.upsert('group1', 'topic', exactContent);
      expect(memory.content).toBe(exactContent);
    });

    it('should preserve createdAt on update but change updatedAt', async () => {
      setup();
      const first = store.upsert('group1', 'topic', 'V1');
      await new Promise(resolve => setTimeout(resolve, 20));
      const second = store.upsert('group1', 'topic', 'V2');
      expect(second.createdAt).toBe(first.createdAt);
      expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
    });
  });

  describe('get', () => {
    it('should return memory for existing topic', () => {
      setup();
      store.upsert('group1', 'holiday plans', 'Byron Bay');
      const memory = store.get('group1', 'holiday plans');
      expect(memory).not.toBeNull();
      expect(memory?.topic).toBe('holiday plans');
      expect(memory?.content).toBe('Byron Bay');
    });

    it('should return null for non-existent topic', () => {
      setup();
      const memory = store.get('group1', 'nonexistent');
      expect(memory).toBeNull();
    });
  });

  describe('getByGroup', () => {
    it('should return all memories for a group', () => {
      setup();
      store.upsert('group1', 'topic A', 'Content A');
      store.upsert('group1', 'topic B', 'Content B');
      const memories = store.getByGroup('group1');
      expect(memories).toHaveLength(2);
    });

    it('should not return memories from other groups', () => {
      setup();
      store.upsert('group1', 'topic A', 'Content A');
      store.upsert('group2', 'topic B', 'Content B');
      const memories = store.getByGroup('group1');
      expect(memories).toHaveLength(1);
      expect(memories[0].topic).toBe('topic A');
    });

    it('should return empty array when none exist', () => {
      setup();
      const memories = store.getByGroup('group1');
      expect(memories).toEqual([]);
    });

    it('should return ordered by topic ASC', () => {
      setup();
      store.upsert('group1', 'charlie', 'C');
      store.upsert('group1', 'alpha', 'A');
      store.upsert('group1', 'bravo', 'B');
      const memories = store.getByGroup('group1');
      expect(memories[0].topic).toBe('alpha');
      expect(memories[1].topic).toBe('bravo');
      expect(memories[2].topic).toBe('charlie');
    });

    it('should reject empty groupId', () => {
      setup();
      expect(() => store.getByGroup('')).toThrow('Invalid groupId: cannot be empty');
    });
  });

  describe('delete', () => {
    it('should delete an existing memory', () => {
      setup();
      store.upsert('group1', 'topic', 'Content');
      const result = store.delete('group1', 'topic');
      expect(result).toBe(true);
      const memory = store.get('group1', 'topic');
      expect(memory).toBeNull();
    });

    it('should return false for non-existent memory', () => {
      setup();
      const result = store.delete('group1', 'nonexistent');
      expect(result).toBe(false);
    });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd bot && npx vitest run tests/stores/memoryStore.test.ts`
Expected: FAIL — module not found

**Step 3: Implement MemoryStore**

Create `bot/src/stores/memoryStore.ts`:

```typescript
import type Database from 'better-sqlite3';
import type { DatabaseConnection } from '../db';
import { wrapSqliteError } from '../db';
import { estimateTokens } from '../mcp/result';
import type { Memory } from '../types';

export const MEMORY_TOKEN_LIMIT = 500;

export class MemoryStore {
  private conn: DatabaseConnection;
  private stmts: {
    upsert: Database.Statement;
    get: Database.Statement;
    getByGroup: Database.Statement;
    delete: Database.Statement;
  };

  constructor(conn: DatabaseConnection) {
    this.conn = conn;
    this.stmts = {
      upsert: conn.db.prepare(`
        INSERT INTO memories (groupId, topic, content, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(groupId, topic) DO UPDATE SET
          content = excluded.content,
          updatedAt = excluded.updatedAt
        RETURNING *
      `),
      get: conn.db.prepare(`
        SELECT * FROM memories WHERE groupId = ? AND topic = ?
      `),
      getByGroup: conn.db.prepare(`
        SELECT * FROM memories WHERE groupId = ? ORDER BY topic ASC
      `),
      delete: conn.db.prepare(`
        DELETE FROM memories WHERE groupId = ? AND topic = ?
      `),
    };
  }

  upsert(groupId: string, topic: string, content: string): Memory {
    this.conn.ensureOpen();
    if (!groupId || groupId.trim() === '') {
      throw new Error('Invalid groupId: cannot be empty');
    }
    if (!topic || topic.trim() === '') {
      throw new Error('Invalid topic: cannot be empty');
    }
    if (estimateTokens(content) > MEMORY_TOKEN_LIMIT) {
      throw new Error(`Content exceeds token limit of ${MEMORY_TOKEN_LIMIT} tokens`);
    }

    try {
      const now = Date.now();
      const row = this.stmts.upsert.get(groupId, topic, content, now, now) as Memory;
      return row;
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.startsWith('Invalid ') || error.message.startsWith('Content exceeds'))
      ) {
        throw error;
      }
      wrapSqliteError(error, 'upsert memory');
    }
  }

  get(groupId: string, topic: string): Memory | null {
    this.conn.ensureOpen();

    try {
      const row = this.stmts.get.get(groupId, topic) as Memory | undefined;
      return row ?? null;
    } catch (error) {
      wrapSqliteError(error, 'get memory');
    }
  }

  getByGroup(groupId: string): Memory[] {
    this.conn.ensureOpen();
    if (!groupId || groupId.trim() === '') {
      throw new Error('Invalid groupId: cannot be empty');
    }

    try {
      return this.stmts.getByGroup.all(groupId) as Memory[];
    } catch (error) {
      wrapSqliteError(error, 'get memories by group');
    }
  }

  delete(groupId: string, topic: string): boolean {
    this.conn.ensureOpen();

    try {
      const result = this.stmts.delete.run(groupId, topic);
      return result.changes > 0;
    } catch (error) {
      wrapSqliteError(error, 'delete memory');
    }
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `cd bot && npx vitest run tests/stores/memoryStore.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add bot/src/stores/memoryStore.ts bot/tests/stores/memoryStore.test.ts
git commit -m "feat: add MemoryStore with CRUD operations"
```

---

### Task 4: Add Storage facade methods

**Files:**
- Modify: `bot/src/storage.ts:86-103` (after dossier methods)
- Create: `bot/tests/storage.memories.test.ts`

**Step 1: Write the failing tests**

Create `bot/tests/storage.memories.test.ts`:

```typescript
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Storage } from '../src/storage';
import { MEMORY_TOKEN_LIMIT } from '../src/stores/memoryStore';

describe('Storage - Memories', () => {
  let testDir: string;
  let storage: Storage;

  const createStorage = () => {
    testDir = mkdtempSync(join(tmpdir(), 'signal-bot-memory-test-'));
    storage = new Storage(join(testDir, 'test.db'));
    return storage;
  };

  afterEach(() => {
    storage?.close();
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('upsertMemory', () => {
    it('should create a new memory', () => {
      createStorage();
      const memory = storage.upsertMemory('group1', 'holiday plans', 'Byron Bay in April');
      expect(memory).toMatchObject({
        groupId: 'group1',
        topic: 'holiday plans',
        content: 'Byron Bay in April',
      });
    });

    it('should update an existing memory', () => {
      createStorage();
      storage.upsertMemory('group1', 'holiday plans', 'Original');
      const updated = storage.upsertMemory('group1', 'holiday plans', 'Updated');
      expect(updated.content).toBe('Updated');
    });

    it('should reject content exceeding token limit', () => {
      createStorage();
      const longContent = 'a'.repeat(MEMORY_TOKEN_LIMIT * 4 + 1);
      expect(() => storage.upsertMemory('group1', 'topic', longContent)).toThrow('exceeds token limit');
    });
  });

  describe('getMemory', () => {
    it('should return memory for existing topic', () => {
      createStorage();
      storage.upsertMemory('group1', 'holiday plans', 'Byron Bay');
      const memory = storage.getMemory('group1', 'holiday plans');
      expect(memory).not.toBeNull();
      expect(memory?.content).toBe('Byron Bay');
    });

    it('should return null for non-existent topic', () => {
      createStorage();
      expect(storage.getMemory('group1', 'nope')).toBeNull();
    });
  });

  describe('getMemoriesByGroup', () => {
    it('should return all memories for a group', () => {
      createStorage();
      storage.upsertMemory('group1', 'topic A', 'A');
      storage.upsertMemory('group1', 'topic B', 'B');
      expect(storage.getMemoriesByGroup('group1')).toHaveLength(2);
    });

    it('should not return memories from other groups', () => {
      createStorage();
      storage.upsertMemory('group1', 'topic A', 'A');
      storage.upsertMemory('group2', 'topic B', 'B');
      expect(storage.getMemoriesByGroup('group1')).toHaveLength(1);
    });
  });

  describe('deleteMemory', () => {
    it('should delete an existing memory', () => {
      createStorage();
      storage.upsertMemory('group1', 'topic', 'Content');
      expect(storage.deleteMemory('group1', 'topic')).toBe(true);
      expect(storage.getMemory('group1', 'topic')).toBeNull();
    });

    it('should return false for non-existent memory', () => {
      createStorage();
      expect(storage.deleteMemory('group1', 'nope')).toBe(false);
    });
  });

  describe('close guard', () => {
    it('should throw on upsertMemory after close', () => {
      createStorage();
      storage.close();
      expect(() => storage.upsertMemory('g1', 't1', 'c')).toThrow('Database is closed');
    });

    it('should throw on getMemory after close', () => {
      createStorage();
      storage.close();
      expect(() => storage.getMemory('g1', 't1')).toThrow('Database is closed');
    });

    it('should throw on getMemoriesByGroup after close', () => {
      createStorage();
      storage.close();
      expect(() => storage.getMemoriesByGroup('g1')).toThrow('Database is closed');
    });

    it('should throw on deleteMemory after close', () => {
      createStorage();
      storage.close();
      expect(() => storage.deleteMemory('g1', 't1')).toThrow('Database is closed');
    });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd bot && npx vitest run tests/storage.memories.test.ts`
Expected: FAIL — `upsertMemory` is not a function

**Step 3: Add facade methods to Storage**

In `bot/src/storage.ts`:

Add import at top:
```typescript
import { MemoryStore } from './stores/memoryStore';
```

Add to import of types:
```typescript
import type { Dossier, Memory, Message, Persona, Reminder } from './types';
```

Add `memories` store in class properties and constructor:
```typescript
readonly memories: MemoryStore;
// In constructor, after dossiers:
this.memories = new MemoryStore(this.conn);
```

Add facade methods after the dossier methods section:
```typescript
// === Memory methods (delegate to MemoryStore) ===

upsertMemory(groupId: string, topic: string, content: string): Memory {
  return this.memories.upsert(groupId, topic, content);
}

getMemory(groupId: string, topic: string): Memory | null {
  return this.memories.get(groupId, topic);
}

getMemoriesByGroup(groupId: string): Memory[] {
  return this.memories.getByGroup(groupId);
}

deleteMemory(groupId: string, topic: string): boolean {
  return this.memories.delete(groupId, topic);
}
```

**Step 4: Run tests to verify they pass**

Run: `cd bot && npx vitest run tests/storage.memories.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add bot/src/storage.ts bot/tests/storage.memories.test.ts
git commit -m "feat: add memory facade methods to Storage"
```

---

### Task 5: Create Memory MCP server

**Files:**
- Create: `bot/src/mcp/servers/memories.ts`
- Create: `bot/tests/memoryMcpServer.test.ts`

**Step 1: Write the failing tests**

Create `bot/tests/memoryMcpServer.test.ts`:

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
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  function spawnMcpServer(env: Record<string, string> = {}): ChildProcess {
    return spawnServer('mcp/servers/memories.ts', {
      DB_PATH: dbPath,
      MCP_GROUP_ID: 'test-group-1',
      MCP_SENDER: '+61400000000',
      ...env,
    });
  }

  it('should respond to initialize request', async () => {
    const proc = spawnMcpServer();
    try {
      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
      });

      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBe(1);
      const result = response.result as Record<string, unknown>;
      expect(result.capabilities).toEqual({ tools: {} });
      const serverInfo = result.serverInfo as Record<string, string>;
      expect(serverInfo.name).toBe('signal-bot-memories');
    } finally {
      proc.kill();
    }
  });

  it('should list 4 tools', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);
      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
      });

      const result = response.result as { tools: Array<{ name: string }> };
      expect(result.tools).toHaveLength(4);
      expect(result.tools.map(t => t.name)).toEqual(['save_memory', 'get_memory', 'list_memories', 'delete_memory']);
    } finally {
      proc.kill();
    }
  });

  it('should save a memory', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);
      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'save_memory',
          arguments: {
            topic: 'holiday plans',
            content: '- Going to Byron Bay in April\n- Zac booked the Airbnb',
          },
        },
      });

      const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Saved memory');
      expect(result.content[0].text).toContain('holiday plans');
      expect(result.content[0].text).toContain('tokens used');
    } finally {
      proc.kill();
    }
  });

  it('should get a memory after creating one', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);

      await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'save_memory',
          arguments: { topic: 'dietary restrictions', content: '- Dad is lactose intolerant' },
        },
      });

      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'get_memory',
          arguments: { topic: 'dietary restrictions' },
        },
      });

      const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('dietary restrictions');
      expect(result.content[0].text).toContain('lactose intolerant');
    } finally {
      proc.kill();
    }
  });

  it('should list memories', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);

      await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'save_memory', arguments: { topic: 'holidays', content: 'Byron Bay' } },
      });

      await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'save_memory', arguments: { topic: 'diet', content: 'Lactose free' } },
      });

      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'list_memories', arguments: {} },
      });

      const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('holidays');
      expect(result.content[0].text).toContain('diet');
    } finally {
      proc.kill();
    }
  });

  it('should delete a memory', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);

      await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'save_memory', arguments: { topic: 'temp', content: 'temporary' } },
      });

      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'delete_memory', arguments: { topic: 'temp' } },
      });

      const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Deleted memory');
    } finally {
      proc.kill();
    }
  });

  it('should return "No memory found" for nonexistent topic', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);

      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'get_memory', arguments: { topic: 'nonexistent' } },
      });

      const result = response.result as { content: Array<{ text: string }> };
      expect(result.content[0].text).toContain('No memory found');
    } finally {
      proc.kill();
    }
  });

  it('should return "No memories found" for empty group', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);

      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'list_memories', arguments: {} },
      });

      const result = response.result as { content: Array<{ text: string }> };
      expect(result.content[0].text).toContain('No memories found');
    } finally {
      proc.kill();
    }
  });

  it('should return error when topic is missing for save_memory', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);

      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'save_memory', arguments: { content: 'some content' } },
      });

      const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('topic');
    } finally {
      proc.kill();
    }
  });

  it('should return error when content is missing for save_memory', async () => {
    const proc = spawnMcpServer();
    try {
      await initializeServer(proc);

      const response = await sendAndReceive(proc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'save_memory', arguments: { topic: 'test' } },
      });

      const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('content');
    } finally {
      proc.kill();
    }
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd bot && npx vitest run tests/memoryMcpServer.test.ts`
Expected: FAIL — module not found

**Step 3: Implement the MCP server**

Create `bot/src/mcp/servers/memories.ts`:

```typescript
import { DatabaseConnection } from '../../db';
import { MemoryStore } from '../../stores/memoryStore';
import { readStorageEnv } from '../env';
import { catchErrors, estimateTokens, ok } from '../result';
import { runServer } from '../runServer';
import type { McpServerDefinition } from '../types';
import { requireGroupId, requireString } from '../validate';

const TOOLS = [
  {
    name: 'save_memory',
    title: 'Save Memory',
    description:
      'Save or update a group memory by topic. Content should be concise bullet points about the topic. Total content must stay under ~500 tokens (~2000 characters). Content REPLACES existing content entirely - always include all existing info plus new info.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        topic: { type: 'string', description: 'Short label for the memory, e.g. "holiday plans", "dietary restrictions"' },
        content: { type: 'string', description: 'The memory content. REPLACES existing content entirely.' },
      },
      required: ['topic', 'content'],
    },
  },
  {
    name: 'get_memory',
    title: 'Get Memory',
    description: 'Get a specific group memory by topic.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        topic: { type: 'string', description: 'The topic to look up' },
      },
      required: ['topic'],
    },
  },
  {
    name: 'list_memories',
    title: 'List Memories',
    description: 'List all saved memories for this group.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'delete_memory',
    title: 'Delete Memory',
    description: 'Delete a memory that is no longer relevant.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        topic: { type: 'string', description: 'The topic to delete' },
      },
      required: ['topic'],
    },
  },
];

let conn: DatabaseConnection;
let store: MemoryStore;
let groupId: string;

export const memoryServer: McpServerDefinition = {
  serverName: 'signal-bot-memories',
  configKey: 'memories',
  entrypoint: 'mcp/servers/memories',
  tools: TOOLS,
  envMapping: { DB_PATH: 'dbPath', MCP_GROUP_ID: 'groupId', MCP_SENDER: 'sender' },
  handlers: {
    save_memory(args) {
      const topic = requireString(args, 'topic');
      if (topic.error) return topic.error;
      const content = requireString(args, 'content');
      if (content.error) return content.error;
      const groupErr = requireGroupId(groupId);
      if (groupErr) return groupErr;

      return catchErrors(() => {
        store.upsert(groupId, topic.value, content.value);
        return ok(
          `Saved memory "${topic.value}". Content: ~${estimateTokens(content.value)} tokens used.`,
        );
      }, 'Failed to save memory');
    },

    get_memory(args) {
      const topic = requireString(args, 'topic');
      if (topic.error) return topic.error;
      const groupErr = requireGroupId(groupId);
      if (groupErr) return groupErr;

      const memory = store.get(groupId, topic.value);
      if (!memory) {
        return ok(`No memory found for topic "${topic.value}" in this group.`);
      }

      const tokenCount = estimateTokens(memory.content);
      return ok(
        `Memory: ${memory.topic}\nContent (~${tokenCount} tokens):\n${memory.content}`,
      );
    },

    list_memories() {
      const groupErr = requireGroupId(groupId);
      if (groupErr) return groupErr;

      const memories = store.getByGroup(groupId);
      if (memories.length === 0) {
        return ok('No memories found for this group.');
      }

      const lines = memories.map(m => `- **${m.topic}**: ${m.content}`);
      return ok(`Group memories:\n${lines.join('\n')}`);
    },

    delete_memory(args) {
      const topic = requireString(args, 'topic');
      if (topic.error) return topic.error;
      const groupErr = requireGroupId(groupId);
      if (groupErr) return groupErr;

      const deleted = store.delete(groupId, topic.value);
      if (!deleted) {
        return ok(`No memory found for topic "${topic.value}" to delete.`);
      }
      return ok(`Deleted memory "${topic.value}".`);
    },
  },
  onInit() {
    const env = readStorageEnv();
    conn = new DatabaseConnection(env.dbPath);
    store = new MemoryStore(conn);
    groupId = env.groupId;
    console.error(`Memory MCP server started (group: ${groupId || 'none'}, sender: ${env.sender || 'none'})`);
  },
  onClose() {
    conn.close();
  },
};

if (require.main === module) {
  runServer(memoryServer);
}
```

**Step 4: Run tests to verify they pass**

Run: `cd bot && npx vitest run tests/memoryMcpServer.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add bot/src/mcp/servers/memories.ts bot/tests/memoryMcpServer.test.ts
git commit -m "feat: add Memory MCP server with 4 tools"
```

---

### Task 6: Register Memory server in ALL_SERVERS

**Files:**
- Modify: `bot/src/mcp/servers/index.ts`

**Step 1: Add import and registration**

Add import:
```typescript
import { memoryServer } from './memories';
```

Add `memoryServer` to the `ALL_SERVERS` array (after `dossierServer`):
```typescript
export const ALL_SERVERS: McpServerDefinition[] = [
  githubServer,
  reminderServer,
  dossierServer,
  memoryServer,
  messageHistoryServer,
  weatherServer,
  sourceCodeServer,
  signalServer,
  personaServer,
];
```

**Step 2: Verify it compiles**

Run: `cd bot && npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add bot/src/mcp/servers/index.ts
git commit -m "feat: register memory server in ALL_SERVERS"
```

---

### Task 7: Add context injection in messageHandler

**Files:**
- Modify: `bot/src/messageHandler.ts:152-167`

**Step 1: Add memory context injection**

In `processLlmRequest`, after the dossier context block (after line 163 — `contextParts.push(...)`), add:

```typescript
const MEMORY_CONTEXT_BUDGET = 2000;
const memories = storage.getMemoriesByGroup(groupId);
if (memories.length > 0) {
  let tokenTotal = 0;
  const memoryLines: string[] = [];
  for (const m of memories) {
    const line = `- **${m.topic}**: ${m.content}`;
    const tokens = Math.ceil(line.length / 4);
    if (tokenTotal + tokens > MEMORY_CONTEXT_BUDGET) break;
    tokenTotal += tokens;
    memoryLines.push(line);
  }
  if (memoryLines.length > 0) {
    contextParts.push(`## Group Memory\n${memoryLines.join('\n')}`);
  }
}
```

This goes between the dossier block and the skill content block, so the context order is: dossiers → memories → skills.

**Step 2: Run the full test suite to verify nothing broke**

Run: `cd bot && npx vitest run`
Expected: ALL PASS

**Step 3: Commit**

```bash
git add bot/src/messageHandler.ts
git commit -m "feat: inject group memories into LLM context"
```

---

### Task 8: Add memory maintenance skill

**Files:**
- Create: `bot/src/skills/memory-maintenance.md`

**Step 1: Create the skill file**

Create `bot/src/skills/memory-maintenance.md`:

```markdown
## Memory Maintenance

You have access to a group memory system for remembering facts, decisions, preferences, and recurring topics that belong to the group rather than any individual person. Use it to build persistent group knowledge.

### Tools

- `save_memory(topic, content)` -- Save or update a memory by topic. The `content` field replaces all existing content entirely.
- `get_memory(topic)` -- Read a specific memory.
- `list_memories()` -- List all saved memories for this group.
- `delete_memory(topic)` -- Remove a memory that is no longer relevant.

### When to Save Memories

Save a memory when the group:
- Makes a decision (e.g. "we're going to Byron Bay in April")
- Establishes a preference (e.g. "we do pizza night on Fridays")
- Shares important facts (e.g. "Dad is lactose intolerant", "the WiFi password is ...")
- Plans something recurring (e.g. "family dinner every Sunday at 6pm")
- Explicitly asks you to remember something about the group

### When NOT to Save

- Information that belongs to one person → use dossiers instead
- Trivial or ephemeral details (e.g. "it's raining today")
- Anything that's already in a dossier

### How to Update

1. Always call `get_memory` first to read the existing content before updating.
2. When calling `save_memory`, include ALL existing content plus any new information. Content is replaced entirely -- anything you omit will be lost.
3. Keep content as concise bullet points.
4. Stay under 500 tokens (~2000 characters) per memory. If approaching the limit, summarize and condense older or less important points.
5. Use short, descriptive topic names (e.g. "holiday plans", "dietary restrictions", "house rules").

### Cleanup

- Delete memories that are clearly outdated or no longer relevant (e.g. past events, cancelled plans).
- When a memory grows too long, split it into multiple memories with more specific topics.

### Behavior

- Do NOT mention the memory system to users unprompted. Do not say "I've saved that to memory" unless they explicitly asked you to remember something.
- Use memory information naturally in conversation, as shared group context.
- When someone asks "what do you remember?" or "what do you know about us?", reference both dossiers (people) and memories (group knowledge).
```

**Step 2: Verify skill loads**

Run: `cd bot && npx vitest run tests/contextBuilder.test.ts`
Expected: PASS (skill content loading still works)

**Step 3: Commit**

```bash
git add bot/src/skills/memory-maintenance.md
git commit -m "feat: add memory maintenance skill instructions"
```

---

### Task 9: Run full test suite and verify

**Step 1: Run all tests**

Run: `cd bot && npx vitest run`
Expected: ALL PASS

**Step 2: Run lint**

Run: `cd bot && npm run check`
Expected: No errors

**Step 3: Final commit if any fixups needed**

---

Plan complete and saved to `docs/plans/2026-03-06-group-memory-design.md`. Two execution options:

**1. Subagent-Driven (this session)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** - Open a new session with executing-plans, batch execution with checkpoints

Which approach?