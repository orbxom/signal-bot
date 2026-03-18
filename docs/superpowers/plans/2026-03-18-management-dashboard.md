# Management Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a unified management dashboard combining ops monitoring, data management, and group lifecycle management for the Signal Family Bot.

**Architecture:** Single Express server serving a React + Vite SPA, with REST API, WebSocket for real-time updates, shared SQLite DB access via existing bot store classes, and signal-cli JSON-RPC integration for group management. Replaces the existing Dark Factory dashboard.

**Tech Stack:** React 18, Vite, Express, WebSocket (ws), better-sqlite3 (shared), Chokidar, TypeScript, Vitest

**Spec:** `docs/superpowers/specs/2026-03-18-management-dashboard-design.md`

---

## File Map

### Bot-side changes (Phase 1)

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `bot/src/stores/groupSettingsStore.ts` | CRUD for `group_settings` table, replaces `ToolNotificationStore` |
| Modify | `bot/src/db.ts` | Add migration V8 (create `group_settings`, migrate `tool_notification_settings`, drop old table) |
| Modify | `bot/src/storage.ts` | Replace `toolNotifications` with `groupSettings` property |
| Modify | `bot/src/stores/reminderStore.ts` | Add `listAll()` with pagination and filters |
| Modify | `bot/src/stores/recurringReminderStore.ts` | Add `listAll()` and `resetFailures()` |
| Modify | `bot/src/stores/dossierStore.ts` | Add `listAll()` with pagination |
| Modify | `bot/src/stores/memoryStore.ts` | Add `listAll()` with pagination |
| Modify | `bot/src/stores/attachmentStore.ts` | Add `listMetadata()`, `getStats()`, `deleteById()` |
| Modify | `bot/src/signalClient.ts` | Add `listGroups()`, `getGroup()`, `quitGroup()` |
| Modify | `bot/src/messageHandler.ts` | Check `groupSettings.isEnabled()` before processing, per-group trigger resolution |
| Modify | `bot/src/index.ts` | Pass `groupSettings` store to MessageHandler |
| Modify | `bot/src/mcp/servers/settings.ts` | Update to use `GroupSettingsStore` instead of `ToolNotificationStore` |
| Delete | `bot/src/stores/toolNotificationStore.ts` | Replaced by `GroupSettingsStore` |
| Create | `bot/tests/stores/groupSettingsStore.test.ts` | Tests for GroupSettingsStore |
| Modify | `bot/tests/stores/toolNotificationStore.test.ts` → rename to `groupSettingsStore.test.ts` | Updated tests |

### Dashboard backend (Phase 2)

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `dashboard/src/server.ts` | Express server, WebSocket, Vite middleware (replaces existing) |
| Create | `dashboard/src/services/healthService.ts` | Health checks, signal-cli ping, process stats |
| Create | `dashboard/src/services/factoryService.ts` | Chokidar watcher for factory runs (migrated from `watcher.ts`) |
| Create | `dashboard/src/services/dbPoller.ts` | Polls SQLite for changes, emits events |
| Create | `dashboard/src/websocket.ts` | WebSocket event hub, broadcast to clients |
| Create | `dashboard/src/routes/health.ts` | `GET /api/health`, `GET /api/stats` |
| Create | `dashboard/src/routes/groups.ts` | Group CRUD + signal-cli integration |
| Create | `dashboard/src/routes/reminders.ts` | Reminder list/cancel routes |
| Create | `dashboard/src/routes/dossiers.ts` | Dossier CRUD routes |
| Create | `dashboard/src/routes/personas.ts` | Persona CRUD routes |
| Create | `dashboard/src/routes/memories.ts` | Memory CRUD routes |
| Create | `dashboard/src/routes/messages.ts` | Message search/browse routes |
| Create | `dashboard/src/routes/attachments.ts` | Attachment list/serve/delete routes |
| Create | `dashboard/src/routes/factory.ts` | Factory runs list route |
| Modify | `dashboard/package.json` | Add express, vite, react deps |
| Modify | `dashboard/tsconfig.json` | Add path aliases for bot imports |
| Delete | `dashboard/src/watcher.ts` | Replaced by `factoryService.ts` |
| Delete | `dashboard/src/types.ts` | Types move into new files |
| Delete | `dashboard/public/index.html` | Replaced by React SPA |

### Dashboard frontend (Phase 3)

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `dashboard/client/vite.config.ts` | Vite config with API/WS proxy |
| Create | `dashboard/client/index.html` | Vite entry HTML |
| Create | `dashboard/client/src/main.tsx` | React mount point |
| Create | `dashboard/client/src/App.tsx` | Router + Sidebar layout |
| Create | `dashboard/client/src/App.css` | Global styles (dark theme) |
| Create | `dashboard/client/src/hooks/useWebSocket.ts` | WebSocket connection + auto-reconnect |
| Create | `dashboard/client/src/hooks/useApi.ts` | Fetch wrapper with error handling |
| Create | `dashboard/client/src/components/Sidebar.tsx` | Navigation sidebar |
| Create | `dashboard/client/src/components/StatusCard.tsx` | Metric card component |
| Create | `dashboard/client/src/components/DataTable.tsx` | Reusable paginated table |
| Create | `dashboard/client/src/pages/Dashboard.tsx` | Home page — health, groups, reminders |
| Create | `dashboard/client/src/pages/Groups.tsx` | Group list page |
| Create | `dashboard/client/src/pages/GroupDetail.tsx` | Per-group tabbed detail page |
| Create | `dashboard/client/src/pages/Reminders.tsx` | All reminders across groups |
| Create | `dashboard/client/src/pages/Dossiers.tsx` | All dossiers across groups |
| Create | `dashboard/client/src/pages/Personas.tsx` | Persona management |
| Create | `dashboard/client/src/pages/Memories.tsx` | Memory management |
| Create | `dashboard/client/src/pages/Messages.tsx` | Message search/browse |
| Create | `dashboard/client/src/pages/Attachments.tsx` | Attachment browser + stats |
| Create | `dashboard/client/src/pages/Factory.tsx` | Dark factory pipeline (React rewrite) |

---

## Phase 1: Bot-Side Foundation

### Task 1: Migration V8 + GroupSettingsStore

**Files:**
- Create: `bot/src/stores/groupSettingsStore.ts`
- Modify: `bot/src/db.ts:268-276` (add migrateToV8 after migrateToV7)
- Modify: `bot/src/db.ts:116-157` (update runMigrations to include V8)
- Create: `bot/tests/stores/groupSettingsStore.test.ts`

- [ ] **Step 1: Write GroupSettingsStore tests**

```typescript
// bot/tests/stores/groupSettingsStore.test.ts
import { afterEach, describe, expect, it } from 'vitest'
import { GroupSettingsStore } from '../../src/stores/groupSettingsStore'
import { createTestDb, type TestDb } from '../helpers/testDb'

describe('GroupSettingsStore', () => {
  let db: TestDb

  afterEach(() => db?.cleanup())

  const setup = () => {
    db = createTestDb('group-settings-')
    return new GroupSettingsStore(db.conn)
  }

  it('returns default settings for unknown group', () => {
    const store = setup()
    const settings = store.get('unknown-group')
    expect(settings).toBeNull()
  })

  it('isEnabled returns true for unknown group', () => {
    const store = setup()
    expect(store.isEnabled('unknown-group')).toBe(true)
  })

  it('upserts and retrieves settings', () => {
    const store = setup()
    store.upsert('group1', { enabled: false, toolNotifications: true })
    const settings = store.get('group1')
    expect(settings).not.toBeNull()
    expect(settings!.enabled).toBe(false)
    expect(settings!.toolNotifications).toBe(true)
    expect(settings!.customTriggers).toBeNull()
    expect(settings!.contextWindowSize).toBeNull()
  })

  it('isEnabled returns false for disabled group', () => {
    const store = setup()
    store.upsert('group1', { enabled: false })
    expect(store.isEnabled('group1')).toBe(false)
  })

  it('upserts custom triggers as JSON', () => {
    const store = setup()
    store.upsert('group1', { customTriggers: ['@bot', 'hey bot'] })
    const triggers = store.getTriggers('group1')
    expect(triggers).toEqual(['@bot', 'hey bot'])
  })

  it('getTriggers returns null for unknown group', () => {
    const store = setup()
    expect(store.getTriggers('unknown')).toBeNull()
  })

  it('getToolNotifications returns true by default', () => {
    const store = setup()
    expect(store.getToolNotifications('group1')).toBe(true)
  })

  it('updates existing settings', () => {
    const store = setup()
    store.upsert('group1', { enabled: true })
    store.upsert('group1', { enabled: false, contextWindowSize: 100 })
    const settings = store.get('group1')
    expect(settings!.enabled).toBe(false)
    expect(settings!.contextWindowSize).toBe(100)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd bot && npx vitest run tests/stores/groupSettingsStore.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write GroupSettingsStore implementation**

```typescript
// bot/src/stores/groupSettingsStore.ts
import type { DatabaseConnection } from '../db'

export interface GroupSettings {
  groupId: string
  enabled: boolean
  customTriggers: string[] | null
  contextWindowSize: number | null
  toolNotifications: boolean
  createdAt: number
  updatedAt: number
}

interface UpsertInput {
  enabled?: boolean
  customTriggers?: string[] | null
  contextWindowSize?: number | null
  toolNotifications?: boolean
}

export class GroupSettingsStore {
  private readonly get_: ReturnType<DatabaseConnection['db']['prepare']>
  private readonly upsert_: ReturnType<DatabaseConnection['db']['prepare']>
  private readonly isEnabled_: ReturnType<DatabaseConnection['db']['prepare']>
  private readonly getTriggers_: ReturnType<DatabaseConnection['db']['prepare']>
  private readonly getToolNotifications_: ReturnType<DatabaseConnection['db']['prepare']>
  private readonly listAll_: ReturnType<DatabaseConnection['db']['prepare']>

  constructor(conn: DatabaseConnection) {
    this.get_ = conn.db.prepare(
      'SELECT * FROM group_settings WHERE groupId = ?'
    )
    this.upsert_ = conn.db.prepare(`
      INSERT INTO group_settings (groupId, enabled, customTriggers, contextWindowSize, toolNotifications, createdAt, updatedAt)
      VALUES (@groupId, @enabled, @customTriggers, @contextWindowSize, @toolNotifications, @now, @now)
      ON CONFLICT(groupId) DO UPDATE SET
        enabled = @enabled,
        customTriggers = @customTriggers,
        contextWindowSize = @contextWindowSize,
        toolNotifications = @toolNotifications,
        updatedAt = @now
    `)
    this.isEnabled_ = conn.db.prepare(
      'SELECT enabled FROM group_settings WHERE groupId = ?'
    )
    this.getTriggers_ = conn.db.prepare(
      'SELECT customTriggers FROM group_settings WHERE groupId = ?'
    )
    this.getToolNotifications_ = conn.db.prepare(
      'SELECT toolNotifications FROM group_settings WHERE groupId = ?'
    )
    this.listAll_ = conn.db.prepare(
      'SELECT * FROM group_settings ORDER BY updatedAt DESC LIMIT ? OFFSET ?'
    )
  }

  get(groupId: string): GroupSettings | null {
    const row = this.get_.get(groupId) as Record<string, unknown> | undefined
    return row ? this.mapRow(row) : null
  }

  upsert(groupId: string, input: UpsertInput): void {
    const existing = this.get(groupId)
    this.upsert_.run({
      groupId,
      enabled: (input.enabled ?? existing?.enabled ?? true) ? 1 : 0,
      customTriggers: input.customTriggers !== undefined
        ? (input.customTriggers ? JSON.stringify(input.customTriggers) : null)
        : (existing?.customTriggers ? JSON.stringify(existing.customTriggers) : null),
      contextWindowSize: input.contextWindowSize ?? existing?.contextWindowSize ?? null,
      toolNotifications: (input.toolNotifications ?? existing?.toolNotifications ?? true) ? 1 : 0,
      now: Date.now(),
    })
  }

  isEnabled(groupId: string): boolean {
    const row = this.isEnabled_.get(groupId) as { enabled: number } | undefined
    return row ? row.enabled === 1 : true // default enabled
  }

  getTriggers(groupId: string): string[] | null {
    const row = this.getTriggers_.get(groupId) as { customTriggers: string | null } | undefined
    if (!row || !row.customTriggers) return null
    return JSON.parse(row.customTriggers) as string[]
  }

  getToolNotifications(groupId: string): boolean {
    const row = this.getToolNotifications_.get(groupId) as { toolNotifications: number } | undefined
    return row ? row.toolNotifications === 1 : true // default enabled
  }

  listAll(limit = 50, offset = 0): GroupSettings[] {
    const rows = this.listAll_.all(limit, offset) as Record<string, unknown>[]
    return rows.map(r => this.mapRow(r))
  }

  private mapRow(row: Record<string, unknown>): GroupSettings {
    return {
      groupId: row.groupId as string,
      enabled: (row.enabled as number) === 1,
      customTriggers: row.customTriggers ? JSON.parse(row.customTriggers as string) : null,
      contextWindowSize: row.contextWindowSize as number | null,
      toolNotifications: (row.toolNotifications as number) === 1,
      createdAt: row.createdAt as number,
      updatedAt: row.updatedAt as number,
    }
  }
}
```

- [ ] **Step 4: Add migration V8 to db.ts**

In `bot/src/db.ts`, after `migrateToV7()` (line ~276), add:

```typescript
private migrateToV8(): void {
  this.db.exec(`
    CREATE TABLE IF NOT EXISTS group_settings (
      groupId TEXT PRIMARY KEY,
      enabled INTEGER DEFAULT 1,
      customTriggers TEXT,
      contextWindowSize INTEGER,
      toolNotifications INTEGER DEFAULT 1,
      createdAt INTEGER,
      updatedAt INTEGER
    )
  `)
  // Migrate data from old table
  const rows = this.db.prepare(
    'SELECT groupId, enabled, updatedAt FROM tool_notification_settings'
  ).all() as Array<{ groupId: string; enabled: number; updatedAt: number }>
  const insert = this.db.prepare(`
    INSERT OR IGNORE INTO group_settings (groupId, toolNotifications, enabled, createdAt, updatedAt)
    VALUES (?, ?, 1, ?, ?)
  `)
  for (const row of rows) {
    insert.run(row.groupId, row.enabled, row.updatedAt, row.updatedAt)
  }
  this.db.exec('DROP TABLE IF EXISTS tool_notification_settings')
}
```

Update `runMigrations()` to include V8 (add `if (version < 8) { this.migrateToV8(); this.setSchemaVersion(8) }` after the V7 block).

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd bot && npx vitest run tests/stores/groupSettingsStore.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
cd bot && git add src/stores/groupSettingsStore.ts src/db.ts tests/stores/groupSettingsStore.test.ts
git commit -m "feat: add GroupSettingsStore with migration V8, replacing tool_notification_settings"
```

---

### Task 2: Update Storage facade and settings MCP server

**Files:**
- Modify: `bot/src/storage.ts:14-36` (replace toolNotifications with groupSettings)
- Modify: `bot/src/mcp/servers/settings.ts` (use GroupSettingsStore)
- Delete: `bot/src/stores/toolNotificationStore.ts`
- Modify: existing tests that reference toolNotifications

- [ ] **Step 1: Update Storage facade**

In `bot/src/storage.ts`:
- Replace `import { ToolNotificationStore }` with `import { GroupSettingsStore }`
- Replace `toolNotifications: ToolNotificationStore` field with `groupSettings: GroupSettingsStore`
- In constructor, replace `this.toolNotifications = new ToolNotificationStore(this.conn)` with `this.groupSettings = new GroupSettingsStore(this.conn)`
- Update any delegation methods that reference `toolNotifications`

- [ ] **Step 2: Update settings MCP server**

In `bot/src/mcp/servers/settings.ts`, update tool handlers to use `GroupSettingsStore` methods instead of `ToolNotificationStore`. The `toggle_tool_notifications` handler should call `groupSettings.upsert(groupId, { toolNotifications: enabled })` and `get_tool_notification_status` should call `groupSettings.getToolNotifications(groupId)`.

- [ ] **Step 3: Delete old toolNotificationStore.ts**

Remove `bot/src/stores/toolNotificationStore.ts`.

- [ ] **Step 4: Run full test suite**

Run: `cd bot && npx vitest run`
Expected: All tests pass (fix any that referenced `toolNotifications` on Storage)

- [ ] **Step 5: Commit**

```bash
git add -A bot/src/storage.ts bot/src/stores/ bot/src/mcp/servers/settings.ts bot/tests/
git commit -m "refactor: replace ToolNotificationStore with GroupSettingsStore in Storage facade"
```

---

### Task 3: Add new store methods for dashboard queries

**Files:**
- Modify: `bot/src/stores/reminderStore.ts` — add `listAll()`
- Modify: `bot/src/stores/recurringReminderStore.ts` — add `listAll()`, `resetFailures()`
- Modify: `bot/src/stores/dossierStore.ts` — add `listAll()`
- Modify: `bot/src/stores/memoryStore.ts` — add `listAll()`
- Modify: `bot/src/stores/attachmentStore.ts` — add `listMetadata()`, `getStats()`, `deleteById()`
- Tests: add tests in corresponding test files under `bot/tests/stores/`

- [ ] **Step 1: Write tests for ReminderStore.listAll**

In `bot/tests/stores/reminderStore.test.ts`, add a describe block:

```typescript
describe('listAll', () => {
  it('lists reminders across all groups', () => {
    const store = setup()
    store.create('group1', 'user1', 'reminder1', Date.now() + 10000)
    store.create('group2', 'user2', 'reminder2', Date.now() + 20000)
    const all = store.listAll()
    expect(all).toHaveLength(2)
  })

  it('filters by groupId', () => {
    const store = setup()
    store.create('group1', 'user1', 'reminder1', Date.now() + 10000)
    store.create('group2', 'user2', 'reminder2', Date.now() + 20000)
    const filtered = store.listAll({ groupId: 'group1' })
    expect(filtered).toHaveLength(1)
    expect(filtered[0].groupId).toBe('group1')
  })

  it('filters by status', () => {
    const store = setup()
    const id = store.create('group1', 'user1', 'reminder1', Date.now() + 10000)
    store.create('group1', 'user1', 'reminder2', Date.now() + 20000)
    store.markSent(id)
    const pending = store.listAll({ status: 'pending' })
    expect(pending).toHaveLength(1)
  })

  it('supports pagination', () => {
    const store = setup()
    for (let i = 0; i < 5; i++) {
      store.create('group1', 'user1', `reminder${i}`, Date.now() + i * 1000)
    }
    const page = store.listAll({ limit: 2, offset: 2 })
    expect(page).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd bot && npx vitest run tests/stores/reminderStore.test.ts`
Expected: FAIL — listAll is not a function

- [ ] **Step 3: Implement ReminderStore.listAll**

In `bot/src/stores/reminderStore.ts`, add to constructor a new prepared statement and method:

```typescript
// In constructor, add these prepared statements:
// Note: Dynamic SQL needed for optional filters, use db.prepare() per-call or
// build 4 variants (no filter, groupId only, status only, both)
// Simplest approach: use the raw db connection for this one method

listAll(filters?: { groupId?: string; status?: string; limit?: number; offset?: number }): Reminder[] {
  const limit = Math.min(filters?.limit ?? 50, 200)
  const offset = filters?.offset ?? 0
  const conditions: string[] = []
  const params: unknown[] = []

  if (filters?.groupId) {
    conditions.push('groupId = ?')
    params.push(filters.groupId)
  }
  if (filters?.status) {
    conditions.push('status = ?')
    params.push(filters.status)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const sql = `SELECT * FROM reminders ${where} ORDER BY dueAt DESC LIMIT ? OFFSET ?`
  params.push(limit, offset)

  const rows = this.conn.db.prepare(sql).all(...params) as Array<Record<string, unknown>>
  return rows.map(r => ({
    ...r,
    status: mapReminderRow(r.status as string),
  })) as unknown as Reminder[]
}
```

Note: This method needs access to `this.conn` — store the `conn` reference in the constructor (the existing stores already have access to `conn.db` via their prepared statements, but `listAll` needs `conn.db` directly for dynamic SQL). Check the existing constructor pattern and add `private readonly conn: DatabaseConnection` if not already stored.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd bot && npx vitest run tests/stores/reminderStore.test.ts`
Expected: PASS

- [ ] **Step 5: Repeat the TDD cycle for RecurringReminderStore.listAll and resetFailures**

Write tests, then implement:

```typescript
// RecurringReminderStore additions:
listAll(filters?: { groupId?: string; limit?: number; offset?: number }): RecurringReminder[] {
  const limit = Math.min(filters?.limit ?? 50, 200)
  const offset = filters?.offset ?? 0
  const conditions: string[] = ['status = ?']
  const params: unknown[] = ['active']

  if (filters?.groupId) {
    conditions.push('groupId = ?')
    params.push(filters.groupId)
  }

  const where = `WHERE ${conditions.join(' AND ')}`
  const sql = `SELECT * FROM recurring_reminders ${where} ORDER BY nextDueAt ASC LIMIT ? OFFSET ?`
  params.push(limit, offset)

  return this.conn.db.prepare(sql).all(...params) as RecurringReminder[]
}

resetFailures(id: number): boolean {
  const result = this.conn.db.prepare(
    'UPDATE recurring_reminders SET consecutiveFailures = 0 WHERE id = ?'
  ).run(id)
  return result.changes > 0
}
```

- [ ] **Step 6: Repeat for DossierStore.listAll and MemoryStore.listAll**

Both follow the same pattern — dynamic SQL with optional `groupId` filter and `LIMIT/OFFSET`.

```typescript
// DossierStore.listAll pattern:
listAll(filters?: { groupId?: string; limit?: number; offset?: number }): Dossier[] {
  const limit = Math.min(filters?.limit ?? 50, 200)
  const offset = filters?.offset ?? 0
  if (filters?.groupId) {
    return this.conn.db.prepare(
      'SELECT * FROM dossiers WHERE groupId = ? ORDER BY displayName LIMIT ? OFFSET ?'
    ).all(filters.groupId, limit, offset) as Dossier[]
  }
  return this.conn.db.prepare(
    'SELECT * FROM dossiers ORDER BY displayName LIMIT ? OFFSET ?'
  ).all(limit, offset) as Dossier[]
}
```

MemoryStore follows the identical pattern with `SELECT * FROM memories`.

- [ ] **Step 7: Repeat for AttachmentStore — listMetadata, getStats, deleteById**

```typescript
// AttachmentStore additions:
listMetadata(filters?: { groupId?: string; limit?: number; offset?: number }): Omit<Attachment, 'data'>[] {
  const limit = Math.min(filters?.limit ?? 50, 200)
  const offset = filters?.offset ?? 0
  if (filters?.groupId) {
    return this.conn.db.prepare(
      'SELECT id, groupId, sender, contentType, timestamp FROM attachment_data WHERE groupId = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?'
    ).all(filters.groupId, limit, offset) as Omit<Attachment, 'data'>[]
  }
  return this.conn.db.prepare(
    'SELECT id, groupId, sender, contentType, timestamp FROM attachment_data ORDER BY timestamp DESC LIMIT ? OFFSET ?'
  ).all(limit, offset) as Omit<Attachment, 'data'>[]
}

getStats(): { totalSize: number; countByGroup: Array<{ groupId: string; count: number; size: number }> } {
  const rows = this.conn.db.prepare(
    'SELECT groupId, COUNT(*) as count, SUM(LENGTH(data)) as size FROM attachment_data GROUP BY groupId'
  ).all() as Array<{ groupId: string; count: number; size: number }>
  const totalSize = rows.reduce((sum, r) => sum + (r.size || 0), 0)
  return { totalSize, countByGroup: rows }
}

deleteById(id: string): boolean {
  const result = this.conn.db.prepare('DELETE FROM attachment_data WHERE id = ?').run(id)
  return result.changes > 0
}
```

- [ ] **Step 8: Run full store test suite**

Run: `cd bot && npx vitest run tests/stores/`
Expected: All tests PASS

- [ ] **Step 9: Commit**

```bash
git add bot/src/stores/ bot/tests/stores/
git commit -m "feat: add listAll/pagination methods to stores for dashboard queries"
```

---

### Task 4: Add SignalClient group management methods

**Files:**
- Modify: `bot/src/signalClient.ts:66-88` (add after receiveMessages)
- Modify: `bot/tests/signalClient.test.ts`

- [ ] **Step 1: Write tests for new SignalClient methods**

Add tests to `bot/tests/signalClient.test.ts`. These test the method signatures and error handling. Use a mock HTTP server or spy on fetch.

```typescript
describe('listGroups', () => {
  it('returns groups via JSON-RPC', async () => {
    // Spy on global fetch to return mock response
    const mockGroups = [{ id: 'group1', name: 'Family Chat' }]
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ jsonrpc: '2.0', id: '1', result: mockGroups }))
    )
    const client = new SignalClient('http://localhost:8080', '+61400000000')
    const groups = await client.listGroups()
    expect(groups).toEqual(mockGroups)
  })
})

describe('quitGroup', () => {
  it('calls quitGroup RPC method', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ jsonrpc: '2.0', id: '1', result: {} }))
    )
    const client = new SignalClient('http://localhost:8080', '+61400000000')
    await expect(client.quitGroup('group1')).resolves.not.toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd bot && npx vitest run tests/signalClient.test.ts`
Expected: FAIL — listGroups/quitGroup not found

- [ ] **Step 3: Implement new methods**

In `bot/src/signalClient.ts`, add after `receiveMessages()`:

```typescript
async listGroups(): Promise<unknown[]> {
  return this.rpc<unknown[]>('listGroups')
}

async getGroup(groupId: string): Promise<unknown> {
  return this.rpc<unknown>('getGroup', { groupId })
}

async quitGroup(groupId: string): Promise<void> {
  await this.rpc<void>('quitGroup', { groupId })
}
```

- [ ] **Step 4: Run tests**

Run: `cd bot && npx vitest run tests/signalClient.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add bot/src/signalClient.ts bot/tests/signalClient.test.ts
git commit -m "feat: add listGroups, getGroup, quitGroup to SignalClient"
```

---

### Task 5: Bot integration — group settings in message processing

**Files:**
- Modify: `bot/src/messageHandler.ts:35-74` (constructor, add groupSettings dependency)
- Modify: `bot/src/messageHandler.ts:154-243` (handleMessageBatch, check isEnabled)
- Modify: `bot/src/index.ts:11-74` (pass groupSettings to MessageHandler)
- Modify: existing MessageHandler tests

- [ ] **Step 1: Update MessageHandler constructor**

In `bot/src/messageHandler.ts`, add `groupSettings` to the deps interface. In `handleMessageBatch()`, add an early check:

```typescript
// At top of handleMessageBatch, after getting groupId:
if (!this.deps.storage.groupSettings.isEnabled(groupId)) {
  // Still store messages for history, but don't process mentions
  for (const msg of messages) {
    this.deps.storage.addMessage({ ... })
  }
  return
}
```

For per-group triggers, in the mention detection section, resolve triggers:

```typescript
const customTriggers = this.deps.storage.groupSettings.getTriggers(groupId)
const detector = customTriggers
  ? new MentionDetector(customTriggers)
  : this.mentionDetector  // fall back to global triggers
```

- [ ] **Step 2: Update index.ts**

No changes needed if `MessageHandler` accesses `groupSettings` through `deps.storage.groupSettings` (which it already gets via the Storage facade updated in Task 2).

- [ ] **Step 3: Run full test suite**

Run: `cd bot && npx vitest run`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add bot/src/messageHandler.ts bot/src/index.ts bot/tests/
git commit -m "feat: integrate GroupSettingsStore into message processing (enable/disable, per-group triggers)"
```

---

## Phase 2: Dashboard Backend

### Task 6: Dashboard project scaffold

**Files:**
- Modify: `dashboard/package.json`
- Modify: `dashboard/tsconfig.json`
- Create: `dashboard/client/vite.config.ts`
- Create: `dashboard/client/package.json`
- Create: `dashboard/client/tsconfig.json`
- Create: `dashboard/client/index.html`

- [ ] **Step 1: Update dashboard/package.json**

```json
{
  "name": "signal-bot-dashboard",
  "private": true,
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "dev:client": "cd client && npx vite",
    "build:client": "cd client && npx vite build",
    "start": "tsx src/server.ts"
  },
  "dependencies": {
    "better-sqlite3": "^11.0.0",
    "chokidar": "^5.0.0",
    "express": "^4.21.0",
    "ws": "^8.19.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "@types/express": "^4.17.21",
    "@types/node": "^20.0.0",
    "@types/ws": "^8.18.0",
    "tsx": "^4.7.0",
    "typescript": "^5.3.0"
  }
}
```

- [ ] **Step 2: Update dashboard/tsconfig.json for bot imports**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "moduleResolution": "node",
    "paths": {
      "@bot/*": ["../bot/src/*"]
    },
    "baseUrl": "."
  },
  "include": ["src/**/*"],
  "references": [{ "path": "../bot" }]
}
```

Note: Since the project uses `tsx` for direct execution (not compiled), the `paths` alias works at the TypeScript level. For `tsx` runtime resolution, imports will use relative paths like `../../bot/src/db` (tsx resolves these directly). Alternatively, use `tsconfig-paths` or just use relative imports throughout.

**Decision: Use relative imports** (e.g., `import { Storage } from '../../bot/src/storage'`) for simplicity since tsx resolves them directly. No path aliases needed.

- [ ] **Step 3: Create client/package.json**

```json
{
  "name": "signal-bot-dashboard-client",
  "private": true,
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.28.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "typescript": "^5.3.0",
    "vite": "^5.4.0"
  }
}
```

- [ ] **Step 4: Create client/vite.config.ts**

```typescript
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3333',
      '/ws': {
        target: 'ws://localhost:3333',
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
})
```

- [ ] **Step 5: Create client/tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

- [ ] **Step 6: Create client/index.html**

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Signal Bot Dashboard</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 7: Install dependencies**

```bash
cd dashboard && npm install
cd client && npm install
```

- [ ] **Step 8: Commit**

```bash
git add dashboard/
git commit -m "feat: scaffold dashboard project with Express backend and React+Vite frontend"
```

---

### Task 7: Express server + shared DB + WebSocket hub

**Files:**
- Create: `dashboard/src/server.ts` (replaces existing)
- Create: `dashboard/src/websocket.ts`

- [ ] **Step 1: Write the Express server**

```typescript
// dashboard/src/server.ts
import express from 'express'
import { createServer } from 'http'
import path from 'path'
import { Storage } from '../../bot/src/storage'
import { SignalClient } from '../../bot/src/signalClient'
import { WebSocketHub } from './websocket'
import { createHealthRoutes } from './routes/health'
import { createGroupRoutes } from './routes/groups'
import { createReminderRoutes } from './routes/reminders'
import { createDossierRoutes } from './routes/dossiers'
import { createPersonaRoutes } from './routes/personas'
import { createMemoryRoutes } from './routes/memories'
import { createMessageRoutes } from './routes/messages'
import { createAttachmentRoutes } from './routes/attachments'
import { createFactoryRoutes } from './routes/factory'
import { FactoryService } from './services/factoryService'
import { DbPoller } from './services/dbPoller'
import { HealthService } from './services/healthService'

const PORT = Number(process.env.DASHBOARD_PORT || 3333)
const DB_PATH = process.env.DB_PATH || path.resolve(__dirname, '../../bot/data/bot.db')
const SIGNAL_CLI_URL = process.env.SIGNAL_CLI_URL || 'http://localhost:8080'
const BOT_PHONE_NUMBER = process.env.BOT_PHONE_NUMBER || ''
const FACTORY_RUNS_DIR = process.env.FACTORY_RUNS_DIR || path.resolve(__dirname, '../../factory/runs')

const app = express()
app.use(express.json())

// Shared services
const storage = new Storage(DB_PATH)
const signalClient = new SignalClient(SIGNAL_CLI_URL, BOT_PHONE_NUMBER)
const httpServer = createServer(app)
const wsHub = new WebSocketHub(httpServer)

const healthService = new HealthService(storage, signalClient, DB_PATH)
const factoryService = new FactoryService(FACTORY_RUNS_DIR)
const dbPoller = new DbPoller(storage, wsHub)

// Routes
app.use('/api', createHealthRoutes(healthService, storage))
app.use('/api', createGroupRoutes(storage, signalClient))
app.use('/api', createReminderRoutes(storage))
app.use('/api', createDossierRoutes(storage))
app.use('/api', createPersonaRoutes(storage))
app.use('/api', createMemoryRoutes(storage))
app.use('/api', createMessageRoutes(storage))
app.use('/api', createAttachmentRoutes(storage))
app.use('/api', createFactoryRoutes(factoryService))

// Serve built React app in production
const clientDist = path.resolve(__dirname, '../client/dist')
app.use(express.static(clientDist))
app.get('*', (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'))
})

// Start services
factoryService.start()
factoryService.on('update', (data) => wsHub.broadcast({ type: 'factory:update', data }))
dbPoller.start()

httpServer.listen(PORT, '127.0.0.1', () => {
  console.log(`Dashboard running at http://localhost:${PORT}`)
})

// Graceful shutdown
process.on('SIGINT', () => {
  dbPoller.stop()
  factoryService.stop()
  storage.close()
  httpServer.close()
  process.exit(0)
})
```

- [ ] **Step 2: Write WebSocket hub**

```typescript
// dashboard/src/websocket.ts
import { WebSocketServer, WebSocket } from 'ws'
import type { Server } from 'http'

export interface WsEvent {
  type: string
  data: unknown
}

export class WebSocketHub {
  private wss: WebSocketServer

  constructor(server: Server) {
    this.wss = new WebSocketServer({ server, path: '/ws' })
    this.wss.on('connection', (ws) => {
      ws.on('error', (err) => console.error('WebSocket error:', err))
    })
  }

  broadcast(event: WsEvent): void {
    const message = JSON.stringify(event)
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message)
      }
    }
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/server.ts dashboard/src/websocket.ts
git commit -m "feat: Express server with WebSocket hub for dashboard"
```

---

### Task 8: Health service + DB poller + Factory service

**Files:**
- Create: `dashboard/src/services/healthService.ts`
- Create: `dashboard/src/services/dbPoller.ts`
- Create: `dashboard/src/services/factoryService.ts`

- [ ] **Step 1: Write HealthService**

```typescript
// dashboard/src/services/healthService.ts
import fs from 'fs'
import type { Storage } from '../../../bot/src/storage'
import type { SignalClient } from '../../../bot/src/signalClient'

export class HealthService {
  private startTime = Date.now()

  constructor(
    private storage: Storage,
    private signalClient: SignalClient,
    private dbPath: string,
  ) {}

  async getHealth(): Promise<{
    uptime: number
    memory: NodeJS.MemoryUsage
    dbSize: number
    signalCliReachable: boolean
  }> {
    let signalCliReachable = false
    try {
      await this.signalClient.listGroups()
      signalCliReachable = true
    } catch {
      // signal-cli unreachable
    }

    let dbSize = 0
    try {
      const stat = fs.statSync(this.dbPath)
      dbSize = stat.size
    } catch {
      // DB file not found
    }

    return {
      uptime: Date.now() - this.startTime,
      memory: process.memoryUsage(),
      dbSize,
      signalCliReachable,
    }
  }
}
```

- [ ] **Step 2: Write DbPoller**

```typescript
// dashboard/src/services/dbPoller.ts
import type { Storage } from '../../../bot/src/storage'
import type { WebSocketHub } from '../websocket'

export class DbPoller {
  private interval: ReturnType<typeof setInterval> | null = null
  private lastMessageRowid = 0
  private lastReminderSentRowid = 0
  private lastReminderFailedRowid = 0
  private lastRecurringFiredAt = 0

  constructor(
    private storage: Storage,
    private wsHub: WebSocketHub,
  ) {}

  start(): void {
    // Initialize high-water marks
    this.initHighWaterMarks()
    this.interval = setInterval(() => this.poll(), 2500)
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
    }
  }

  private initHighWaterMarks(): void {
    try {
      const maxMsg = this.storage.conn.db.prepare(
        'SELECT MAX(rowid) as maxId FROM messages'
      ).get() as { maxId: number | null } | undefined
      this.lastMessageRowid = maxMsg?.maxId ?? 0

      const maxSent = this.storage.conn.db.prepare(
        'SELECT MAX(rowid) as maxId FROM reminders WHERE status = ?'
      ).get('sent') as { maxId: number | null } | undefined
      this.lastReminderSentRowid = maxSent?.maxId ?? 0

      const maxFailed = this.storage.conn.db.prepare(
        'SELECT MAX(rowid) as maxId FROM reminders WHERE status = ?'
      ).get('failed') as { maxId: number | null } | undefined
      this.lastReminderFailedRowid = maxFailed?.maxId ?? 0
    } catch {
      // DB not ready yet
    }
  }

  private poll(): void {
    try {
      this.pollMessages()
      this.pollReminders()
    } catch {
      // Silently handle polling errors
    }
  }

  private pollMessages(): void {
    const rows = this.storage.conn.db.prepare(
      'SELECT rowid, groupId, sender, content, timestamp, isBot FROM messages WHERE rowid > ? ORDER BY rowid LIMIT 50'
    ).all(this.lastMessageRowid) as Array<{
      rowid: number; groupId: string; sender: string; content: string; timestamp: number; isBot: number
    }>

    for (const row of rows) {
      this.wsHub.broadcast({
        type: 'message:new',
        data: {
          groupId: row.groupId,
          sender: row.sender,
          preview: row.content?.substring(0, 100) ?? '',
          timestamp: row.timestamp,
          isBot: row.isBot === 1,
        },
      })
      this.lastMessageRowid = row.rowid
    }
  }

  private pollReminders(): void {
    const sent = this.storage.conn.db.prepare(
      'SELECT rowid, id, groupId, reminderText FROM reminders WHERE status = ? AND rowid > ? ORDER BY rowid LIMIT 20'
    ).all('sent', this.lastReminderSentRowid) as Array<{
      rowid: number; id: number; groupId: string; reminderText: string
    }>

    for (const row of sent) {
      this.wsHub.broadcast({
        type: 'reminder:due',
        data: { id: row.id, groupId: row.groupId, text: row.reminderText },
      })
      this.lastReminderSentRowid = row.rowid
    }

    const failed = this.storage.conn.db.prepare(
      'SELECT rowid, id, retryCount, failureReason FROM reminders WHERE status = ? AND rowid > ? ORDER BY rowid LIMIT 20'
    ).all('failed', this.lastReminderFailedRowid) as Array<{
      rowid: number; id: number; retryCount: number; failureReason: string
    }>

    for (const row of failed) {
      this.wsHub.broadcast({
        type: 'reminder:failed',
        data: { id: row.id, retryCount: row.retryCount, error: row.failureReason },
      })
      this.lastReminderFailedRowid = row.rowid
    }
  }
}
```

Note: `this.storage.conn` — the `Storage` class has a `conn` property (`DatabaseConnection`). Check if it's public. If not, either make it public or expose a getter, or pass `DatabaseConnection` separately to `DbPoller`.

- [ ] **Step 3: Write FactoryService (migrated from watcher.ts)**

Adapt the existing `dashboard/src/watcher.ts` `RunWatcher` class into `FactoryService`. Same Chokidar logic, just renamed and with a cleaner interface.

```typescript
// dashboard/src/services/factoryService.ts
import { EventEmitter } from 'events'
import fs from 'fs'
import path from 'path'
import chokidar from 'chokidar'

// Copy the types from the existing dashboard/src/types.ts:
// StatusFile, EventFile, Run, etc.

export class FactoryService extends EventEmitter {
  private watcher: chokidar.FSWatcher | null = null
  private runs = new Map<string, Run>()

  constructor(private runsDir: string) {
    super()
  }

  start(): void {
    if (!fs.existsSync(this.runsDir)) {
      console.log('Factory runs dir not found, factory tab will be empty')
      return
    }
    this.watcher = chokidar.watch(this.runsDir, {
      ignoreInitial: false,
      depth: 1,
      awaitWriteFinish: { stabilityThreshold: 300 },
    })
    this.watcher.on('add', (fp) => this.handleFile(fp))
    this.watcher.on('change', (fp) => this.handleFile(fp))
  }

  stop(): void {
    this.watcher?.close()
  }

  getSnapshot(): Record<string, Run> {
    return Object.fromEntries(this.runs)
  }

  // ... handleFile, getOrCreateRun — migrate directly from existing watcher.ts
}
```

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/services/
git commit -m "feat: add HealthService, DbPoller, and FactoryService for dashboard backend"
```

---

### Task 9: API routes — health, groups, reminders

**Files:**
- Create: `dashboard/src/routes/health.ts`
- Create: `dashboard/src/routes/groups.ts`
- Create: `dashboard/src/routes/reminders.ts`

- [ ] **Step 1: Write health routes**

```typescript
// dashboard/src/routes/health.ts
import { Router } from 'express'
import type { HealthService } from '../services/healthService'
import type { Storage } from '../../../bot/src/storage'

export function createHealthRoutes(healthService: HealthService, storage: Storage): Router {
  const router = Router()

  router.get('/health', async (_req, res) => {
    try {
      const health = await healthService.getHealth()
      res.json(health)
    } catch (err) {
      res.status(500).json({ error: 'Health check failed' })
    }
  })

  router.get('/stats', (_req, res) => {
    try {
      const groups = storage.messages.getDistinctGroupIds()
      const reminderCount = storage.reminders.listAll().length
      const attachmentStats = storage.attachments.getStats()
      res.json({
        groupCount: groups.length,
        reminderCount,
        attachmentCount: attachmentStats.countByGroup.reduce((sum, g) => sum + g.count, 0),
        attachmentSize: attachmentStats.totalSize,
      })
    } catch (err) {
      res.status(500).json({ error: 'Stats fetch failed' })
    }
  })

  return router
}
```

- [ ] **Step 2: Write groups routes**

```typescript
// dashboard/src/routes/groups.ts
import { Router } from 'express'
import type { Storage } from '../../../bot/src/storage'
import type { SignalClient } from '../../../bot/src/signalClient'

export function createGroupRoutes(storage: Storage, signalClient: SignalClient): Router {
  const router = Router()

  router.get('/groups', async (_req, res) => {
    try {
      const signalGroups = await signalClient.listGroups() as Array<{
        id: string; name: string; members: string[]
      }>
      const enriched = signalGroups.map(g => {
        const settings = storage.groupSettings.get(g.id)
        // Count messages and reminders for this group
        const messages = storage.messages.getDistinctGroupIds() // Just checking membership
        return {
          ...g,
          enabled: settings ? settings.enabled : true,
          activePersona: storage.personas.getActiveForGroup(g.id)?.name ?? 'Default',
          settings,
        }
      })
      res.json(enriched)
    } catch (err) {
      res.status(503).json({ error: 'Could not fetch groups — signal-cli may be unreachable' })
    }
  })

  router.get('/groups/:id', async (req, res) => {
    try {
      const group = await signalClient.getGroup(req.params.id) as Record<string, unknown>
      const settings = storage.groupSettings.get(req.params.id)
      const activePersona = storage.personas.getActiveForGroup(req.params.id)
      res.json({ ...group, settings, activePersona })
    } catch (err) {
      res.status(503).json({ error: 'Could not fetch group details' })
    }
  })

  router.post('/groups/:id/leave', async (req, res) => {
    try {
      await signalClient.quitGroup(req.params.id)
      storage.groupSettings.upsert(req.params.id, { enabled: false })
      res.json({ success: true })
    } catch (err) {
      res.status(500).json({ error: 'Failed to leave group' })
    }
  })

  router.patch('/groups/:id/settings', (req, res) => {
    try {
      const { enabled, customTriggers, contextWindowSize, toolNotifications } = req.body
      storage.groupSettings.upsert(req.params.id, {
        enabled,
        customTriggers,
        contextWindowSize,
        toolNotifications,
      })
      res.json(storage.groupSettings.get(req.params.id))
    } catch (err) {
      res.status(500).json({ error: 'Failed to update settings' })
    }
  })

  return router
}
```

- [ ] **Step 3: Write reminder routes**

```typescript
// dashboard/src/routes/reminders.ts
import { Router } from 'express'
import type { Storage } from '../../../bot/src/storage'

export function createReminderRoutes(storage: Storage): Router {
  const router = Router()

  router.get('/reminders', (req, res) => {
    const { groupId, status, limit, offset } = req.query
    const reminders = storage.reminders.listAll({
      groupId: groupId as string | undefined,
      status: status as string | undefined,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    })
    res.json(reminders)
  })

  router.delete('/reminders/:id', (req, res) => {
    const groupId = req.query.groupId as string
    if (!groupId) return res.status(400).json({ error: 'groupId required' })
    const success = storage.reminders.cancel(Number(req.params.id), groupId)
    res.json({ success })
  })

  router.get('/recurring-reminders', (req, res) => {
    const { groupId, limit, offset } = req.query
    const reminders = storage.recurringReminders.listAll({
      groupId: groupId as string | undefined,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    })
    res.json(reminders)
  })

  router.delete('/recurring-reminders/:id', (req, res) => {
    const groupId = req.query.groupId as string
    if (!groupId) return res.status(400).json({ error: 'groupId required' })
    const success = storage.recurringReminders.cancel(Number(req.params.id), groupId)
    res.json({ success })
  })

  router.post('/recurring-reminders/:id/reset-failures', (req, res) => {
    const success = storage.recurringReminders.resetFailures(Number(req.params.id))
    res.json({ success })
  })

  return router
}
```

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/routes/health.ts dashboard/src/routes/groups.ts dashboard/src/routes/reminders.ts
git commit -m "feat: add health, groups, and reminder API routes"
```

---

### Task 10: API routes — dossiers, personas, memories, messages, attachments, factory

**Files:**
- Create: `dashboard/src/routes/dossiers.ts`
- Create: `dashboard/src/routes/personas.ts`
- Create: `dashboard/src/routes/memories.ts`
- Create: `dashboard/src/routes/messages.ts`
- Create: `dashboard/src/routes/attachments.ts`
- Create: `dashboard/src/routes/factory.ts`

- [ ] **Step 1: Write dossier routes**

```typescript
// dashboard/src/routes/dossiers.ts
import { Router } from 'express'
import type { Storage } from '../../../bot/src/storage'

export function createDossierRoutes(storage: Storage): Router {
  const router = Router()

  router.get('/dossiers', (req, res) => {
    const { groupId, limit, offset } = req.query
    const dossiers = storage.dossiers.listAll({
      groupId: groupId as string | undefined,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    })
    res.json(dossiers)
  })

  router.get('/dossiers/:groupId/:personId', (req, res) => {
    const dossier = storage.dossiers.get(req.params.groupId, req.params.personId)
    if (!dossier) return res.status(404).json({ error: 'Dossier not found' })
    res.json(dossier)
  })

  router.put('/dossiers/:groupId/:personId', (req, res) => {
    const { displayName, notes } = req.body
    const dossier = storage.dossiers.upsert(
      req.params.groupId, req.params.personId, displayName, notes
    )
    res.json(dossier)
  })

  router.delete('/dossiers/:groupId/:personId', (req, res) => {
    const success = storage.dossiers.delete(req.params.groupId, req.params.personId)
    res.json({ success })
  })

  return router
}
```

- [ ] **Step 2: Write persona routes**

```typescript
// dashboard/src/routes/personas.ts
import { Router } from 'express'
import type { Storage } from '../../../bot/src/storage'

export function createPersonaRoutes(storage: Storage): Router {
  const router = Router()

  router.get('/personas', (_req, res) => {
    res.json(storage.personas.list())
  })

  router.post('/personas', (req, res) => {
    const { name, description, tags } = req.body
    try {
      const persona = storage.personas.create(name, description, tags)
      res.status(201).json(persona)
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  router.put('/personas/:id', (req, res) => {
    const { name, description, tags } = req.body
    const success = storage.personas.update(Number(req.params.id), name, description, tags)
    res.json({ success })
  })

  router.delete('/personas/:id', (req, res) => {
    const success = storage.personas.delete(Number(req.params.id))
    res.json({ success })
  })

  router.post('/groups/:groupId/persona', (req, res) => {
    const { personaId } = req.body
    storage.personas.setActive(req.params.groupId, personaId)
    res.json({ success: true })
  })

  return router
}
```

- [ ] **Step 3: Write memory routes**

```typescript
// dashboard/src/routes/memories.ts
import { Router } from 'express'
import type { Storage } from '../../../bot/src/storage'

export function createMemoryRoutes(storage: Storage): Router {
  const router = Router()

  router.get('/memories', (req, res) => {
    const { groupId, limit, offset } = req.query
    const memories = storage.memories.listAll({
      groupId: groupId as string | undefined,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    })
    res.json(memories)
  })

  router.put('/memories/:groupId/:topic', (req, res) => {
    const { content } = req.body
    try {
      const memory = storage.memories.upsert(req.params.groupId, req.params.topic, content)
      res.json(memory)
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  router.delete('/memories/:groupId/:topic', (req, res) => {
    const success = storage.memories.delete(req.params.groupId, req.params.topic)
    res.json({ success })
  })

  return router
}
```

- [ ] **Step 4: Write message routes**

```typescript
// dashboard/src/routes/messages.ts
import { Router } from 'express'
import type { Storage } from '../../../bot/src/storage'

export function createMessageRoutes(storage: Storage): Router {
  const router = Router()

  router.get('/messages', (req, res) => {
    const { groupId, search, from, to, limit, offset } = req.query
    if (!groupId) return res.status(400).json({ error: 'groupId required' })

    const startTs = from ? Number(from) : 0
    const endTs = to ? Number(to) : Number.MAX_SAFE_INTEGER
    const lim = Math.min(Number(limit) || 50, 200)

    if (search) {
      const messages = storage.messages.search(
        groupId as string,
        search as string,
        { startTimestamp: startTs, endTimestamp: endTs, limit: lim }
      )
      res.json(messages)
    } else {
      const messages = storage.messages.getByDateRange(
        groupId as string, startTs, endTs, lim
      )
      res.json(messages)
    }
  })

  return router
}
```

- [ ] **Step 5: Write attachment routes**

```typescript
// dashboard/src/routes/attachments.ts
import { Router } from 'express'
import type { Storage } from '../../../bot/src/storage'

export function createAttachmentRoutes(storage: Storage): Router {
  const router = Router()

  router.get('/attachments', (req, res) => {
    const { groupId, limit, offset } = req.query
    const attachments = storage.attachments.listMetadata({
      groupId: groupId as string | undefined,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    })
    res.json(attachments)
  })

  router.get('/attachments/stats', (_req, res) => {
    res.json(storage.attachments.getStats())
  })

  router.get('/attachments/:id/image', (req, res) => {
    const attachment = storage.attachments.get(req.params.id)
    if (!attachment) return res.status(404).json({ error: 'Attachment not found' })
    res.set('Content-Type', attachment.contentType)
    res.send(attachment.data)
  })

  router.delete('/attachments/:id', (req, res) => {
    const success = storage.attachments.deleteById(req.params.id)
    res.json({ success })
  })

  return router
}
```

- [ ] **Step 6: Write factory routes**

```typescript
// dashboard/src/routes/factory.ts
import { Router } from 'express'
import type { FactoryService } from '../services/factoryService'

export function createFactoryRoutes(factoryService: FactoryService): Router {
  const router = Router()

  router.get('/factory/runs', (_req, res) => {
    res.json(factoryService.getSnapshot())
  })

  return router
}
```

- [ ] **Step 7: Verify server starts**

```bash
cd dashboard && npm run dev
```

Expected: Server starts on port 3333 without errors (routes register, DB connects)

- [ ] **Step 8: Commit**

```bash
git add dashboard/src/routes/
git commit -m "feat: add all CRUD API routes (dossiers, personas, memories, messages, attachments, factory)"
```

---

## Phase 3: Dashboard Frontend

### Task 11: React app scaffold — layout, router, sidebar

**Files:**
- Create: `dashboard/client/src/main.tsx`
- Create: `dashboard/client/src/App.tsx`
- Create: `dashboard/client/src/App.css`
- Create: `dashboard/client/src/components/Sidebar.tsx`

- [ ] **Step 1: Write main.tsx**

```tsx
// dashboard/client/src/main.tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './App.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>
)
```

- [ ] **Step 2: Write App.tsx with router**

```tsx
// dashboard/client/src/App.tsx
import { Routes, Route } from 'react-router-dom'
import Sidebar from './components/Sidebar'
import Dashboard from './pages/Dashboard'
import Groups from './pages/Groups'
import GroupDetail from './pages/GroupDetail'
import Reminders from './pages/Reminders'
import Dossiers from './pages/Dossiers'
import Personas from './pages/Personas'
import Memories from './pages/Memories'
import Messages from './pages/Messages'
import Attachments from './pages/Attachments'
import Factory from './pages/Factory'

export default function App() {
  return (
    <div className="app">
      <Sidebar />
      <main className="main-content">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/groups" element={<Groups />} />
          <Route path="/groups/:id" element={<GroupDetail />} />
          <Route path="/reminders" element={<Reminders />} />
          <Route path="/dossiers" element={<Dossiers />} />
          <Route path="/personas" element={<Personas />} />
          <Route path="/memories" element={<Memories />} />
          <Route path="/messages" element={<Messages />} />
          <Route path="/attachments" element={<Attachments />} />
          <Route path="/factory" element={<Factory />} />
        </Routes>
      </main>
    </div>
  )
}
```

- [ ] **Step 3: Write Sidebar component**

```tsx
// dashboard/client/src/components/Sidebar.tsx
import { NavLink } from 'react-router-dom'

const navItems = [
  { path: '/', label: 'Dashboard' },
  { path: '/groups', label: 'Groups' },
  { path: '/reminders', label: 'Reminders' },
  { path: '/dossiers', label: 'Dossiers' },
  { path: '/personas', label: 'Personas' },
  { path: '/memories', label: 'Memories' },
  { path: '/messages', label: 'Messages' },
  { path: '/attachments', label: 'Attachments' },
  { path: '/factory', label: 'Factory', separator: true },
]

export default function Sidebar() {
  return (
    <nav className="sidebar">
      <div className="sidebar-header">Signal Bot</div>
      {navItems.map(item => (
        <div key={item.path}>
          {item.separator && <div className="sidebar-separator" />}
          <NavLink
            to={item.path}
            className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}
            end={item.path === '/'}
          >
            {item.label}
          </NavLink>
        </div>
      ))}
    </nav>
  )
}
```

- [ ] **Step 4: Write App.css (dark theme)**

Write a dark-themed CSS file matching the mockup style (dark backgrounds, purple accents, clean typography). Key classes: `.app` (flex layout), `.sidebar` (fixed width 200px, dark bg), `.sidebar-link` (with `.active` state), `.main-content` (flex-1, padding), `.status-card`, `.data-table`.

Use the color scheme from the brainstorming mockup:
- Background: `#0d0d1a`
- Sidebar: `#1a1a2e`
- Cards: `#1a1a2e` with `#333` borders
- Accent: `#7c7cff`
- Success: `#8f8` / `#6d6`
- Error: `#e74`
- Text: `#fff` / `#aaa`

- [ ] **Step 5: Create placeholder pages**

Create each page file (`Dashboard.tsx`, `Groups.tsx`, etc.) with a minimal placeholder:

```tsx
export default function PageName() {
  return <h1>Page Name</h1>
}
```

- [ ] **Step 6: Verify client builds and runs**

```bash
cd dashboard/client && npm run dev
```

Expected: Vite dev server starts, sidebar navigation works, pages render placeholders

- [ ] **Step 7: Commit**

```bash
git add dashboard/client/
git commit -m "feat: React app scaffold with router, sidebar, and dark theme"
```

---

### Task 12: Shared hooks and components

**Files:**
- Create: `dashboard/client/src/hooks/useWebSocket.ts`
- Create: `dashboard/client/src/hooks/useApi.ts`
- Create: `dashboard/client/src/components/StatusCard.tsx`
- Create: `dashboard/client/src/components/DataTable.tsx`

- [ ] **Step 1: Write useWebSocket hook**

```tsx
// dashboard/client/src/hooks/useWebSocket.ts
import { useEffect, useRef, useCallback, useState } from 'react'

interface WsEvent {
  type: string
  data: unknown
}

export function useWebSocket(onEvent: (event: WsEvent) => void) {
  const [connected, setConnected] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const retryRef = useRef(1000)

  const connect = useCallback(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`)

    ws.onopen = () => {
      setConnected(true)
      retryRef.current = 1000
    }

    ws.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as WsEvent
        onEvent(event)
      } catch { /* ignore parse errors */ }
    }

    ws.onclose = () => {
      setConnected(false)
      setTimeout(connect, Math.min(retryRef.current, 10000))
      retryRef.current *= 2
    }

    wsRef.current = ws
  }, [onEvent])

  useEffect(() => {
    connect()
    return () => wsRef.current?.close()
  }, [connect])

  return { connected }
}
```

- [ ] **Step 2: Write useApi hook**

```tsx
// dashboard/client/src/hooks/useApi.ts
import { useState, useEffect, useCallback } from 'react'

export function useApi<T>(url: string, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refetch = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setData(await res.json())
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [url])

  useEffect(() => { refetch() }, [refetch, ...deps])

  return { data, loading, error, refetch }
}

export async function apiCall(method: string, url: string, body?: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}
```

- [ ] **Step 3: Write StatusCard component**

```tsx
// dashboard/client/src/components/StatusCard.tsx
interface StatusCardProps {
  label: string
  value: string | number
  detail?: string
  variant?: 'default' | 'success' | 'warning' | 'error'
}

export default function StatusCard({ label, value, detail, variant = 'default' }: StatusCardProps) {
  return (
    <div className={`status-card status-card--${variant}`}>
      <div className="status-card__label">{label}</div>
      <div className="status-card__value">{value}</div>
      {detail && <div className="status-card__detail">{detail}</div>}
    </div>
  )
}
```

- [ ] **Step 4: Write DataTable component**

A reusable paginated table supporting column definitions, pagination, and optional row click handler.

```tsx
// dashboard/client/src/components/DataTable.tsx
interface Column<T> {
  key: string
  header: string
  render?: (row: T) => React.ReactNode
}

interface DataTableProps<T> {
  columns: Column<T>[]
  data: T[]
  onRowClick?: (row: T) => void
  loading?: boolean
  emptyMessage?: string
}

export default function DataTable<T extends Record<string, unknown>>({
  columns, data, onRowClick, loading, emptyMessage = 'No data'
}: DataTableProps<T>) {
  if (loading) return <div className="loading">Loading...</div>
  if (data.length === 0) return <div className="empty">{emptyMessage}</div>

  return (
    <table className="data-table">
      <thead>
        <tr>
          {columns.map(col => <th key={col.key}>{col.header}</th>)}
        </tr>
      </thead>
      <tbody>
        {data.map((row, i) => (
          <tr key={i} onClick={() => onRowClick?.(row)} className={onRowClick ? 'clickable' : ''}>
            {columns.map(col => (
              <td key={col.key}>
                {col.render ? col.render(row) : String(row[col.key] ?? '')}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
```

- [ ] **Step 5: Commit**

```bash
git add dashboard/client/src/hooks/ dashboard/client/src/components/
git commit -m "feat: add shared hooks (useWebSocket, useApi) and components (StatusCard, DataTable)"
```

---

### Task 13: Dashboard home page

**Files:**
- Modify: `dashboard/client/src/pages/Dashboard.tsx`

- [ ] **Step 1: Implement Dashboard page**

Build the home page matching the mockup from brainstorming: health status cards, group list with activity, pending reminders, recurring reminder status. Uses `useApi` hook to fetch `/api/health`, `/api/stats`, `/api/groups`, `/api/recurring-reminders`. Uses `useWebSocket` to update health status and message activity in real-time.

Key sections:
- Top row: 4 StatusCards (Bot Status, Active Groups, Pending Reminders, Attachments)
- Groups table with status dot, name, last activity, message count, "Manage" link
- Recurring reminders table with next due time, failure count

- [ ] **Step 2: Verify in browser**

```bash
cd dashboard/client && npm run dev
```

Navigate to `/`. Expected: Dashboard renders with data from the API (or shows error if backend isn't running).

- [ ] **Step 3: Commit**

```bash
git add dashboard/client/src/pages/Dashboard.tsx
git commit -m "feat: implement dashboard home page with health, groups, and reminder overview"
```

---

### Task 14: Groups page + GroupDetail page

**Files:**
- Modify: `dashboard/client/src/pages/Groups.tsx`
- Modify: `dashboard/client/src/pages/GroupDetail.tsx`

- [ ] **Step 1: Implement Groups list page**

Table of all groups with columns: status (enabled/disabled dot), name, last activity, message count, active persona, "Manage" link. Fetches from `GET /api/groups`. Each row links to `/groups/:id`.

- [ ] **Step 2: Implement GroupDetail page**

Tabbed view (Overview, Reminders, Dossiers, Persona, Memories, Messages, Settings) matching the brainstorming mockup. Uses `useParams()` for group ID.

**Overview tab:** Status cards (enabled/disabled, active persona, members, tool notifications) + action buttons (Disable/Enable, Change Persona, Leave Group with confirmation dialog).

**Settings tab:** Form to edit group settings (enabled toggle, custom triggers input, context window size, tool notifications toggle). Submits `PATCH /api/groups/:id/settings`.

**Other tabs:** Filtered versions of the top-level pages (Reminders, Dossiers, etc.) but scoped to this group's ID via query parameter.

- [ ] **Step 3: Commit**

```bash
git add dashboard/client/src/pages/Groups.tsx dashboard/client/src/pages/GroupDetail.tsx
git commit -m "feat: implement Groups list and GroupDetail pages with tabbed view"
```

---

### Task 15: CRUD pages — Reminders, Dossiers, Personas, Memories

**Files:**
- Modify: `dashboard/client/src/pages/Reminders.tsx`
- Modify: `dashboard/client/src/pages/Dossiers.tsx`
- Modify: `dashboard/client/src/pages/Personas.tsx`
- Modify: `dashboard/client/src/pages/Memories.tsx`

- [ ] **Step 1: Implement Reminders page**

Two sections: One-off reminders and Recurring reminders. Each uses `DataTable` with group filter dropdown. One-off shows: group, requester, text, due date, status, cancel button. Recurring shows: group, prompt, cron expression, next due, consecutive failures (with reset button), cancel button.

- [ ] **Step 2: Implement Dossiers page**

DataTable with group filter. Columns: group, person, display name, notes (truncated). Click to expand/edit. Delete button per row.

- [ ] **Step 3: Implement Personas page**

List + create form. Columns: name, description (truncated), tags, is default. Edit/delete buttons (default persona can't be deleted). "Create Persona" form at top.

- [ ] **Step 4: Implement Memories page**

DataTable with group filter. Columns: group, topic, content (truncated). Edit/delete per row.

- [ ] **Step 5: Commit**

```bash
git add dashboard/client/src/pages/Reminders.tsx dashboard/client/src/pages/Dossiers.tsx \
  dashboard/client/src/pages/Personas.tsx dashboard/client/src/pages/Memories.tsx
git commit -m "feat: implement CRUD pages for reminders, dossiers, personas, and memories"
```

---

### Task 16: Messages + Attachments pages

**Files:**
- Modify: `dashboard/client/src/pages/Messages.tsx`
- Modify: `dashboard/client/src/pages/Attachments.tsx`

- [ ] **Step 1: Implement Messages page**

Group selector (required), search input, date range picker. Results in DataTable: sender, content (truncated), timestamp, isBot badge. Read-only — no edit/delete.

- [ ] **Step 2: Implement Attachments page**

Two sections:
- **Stats:** Storage usage overview (total size, count per group) from `GET /api/attachments/stats`
- **Browser:** DataTable of attachment metadata with group filter. Columns: thumbnail (loads from `/api/attachments/:id/image`), group, sender, content type, timestamp, size. Delete button per row.

- [ ] **Step 3: Commit**

```bash
git add dashboard/client/src/pages/Messages.tsx dashboard/client/src/pages/Attachments.tsx
git commit -m "feat: implement Messages search and Attachments browser pages"
```

---

### Task 17: Factory page (React rewrite)

**Files:**
- Modify: `dashboard/client/src/pages/Factory.tsx`

- [ ] **Step 1: Rewrite Factory dashboard in React**

Port the existing Preact SPA (`dashboard/public/index.html`) to React components. Key elements:

- **RunCard:** Pipeline card with stage progress bar (7 segments), status indicator, timestamps
- **StageBar:** 7 colored segments (pending/in-progress/complete/deferred/abandoned)
- **DiaryPanel:** Collapsible markdown-style content viewer
- **Summary header:** Total runs, active count, completed count
- **Connection status:** Online/offline indicator

Uses `useWebSocket` for `factory:update` events and `useApi` for initial `GET /api/factory/runs`.

Port helper functions from the existing SPA: `formatTime()`, `isRunComplete()`, `isRunActive()`, `sortRuns()`.

- [ ] **Step 2: Verify factory tab works**

Start the dashboard, navigate to Factory tab. Expected: Shows factory runs if `factory/runs/` exists, empty state if not.

- [ ] **Step 3: Commit**

```bash
git add dashboard/client/src/pages/Factory.tsx
git commit -m "feat: rewrite Dark Factory dashboard as React component"
```

---

### Task 18: Cleanup and integration testing

**Files:**
- Delete: `dashboard/public/index.html`
- Delete: `dashboard/src/watcher.ts`
- Delete: `dashboard/src/types.ts`
- Modify: `dashboard/package.json` (update scripts)

- [ ] **Step 1: Remove old dashboard files**

Delete the old Preact SPA and standalone server files that have been replaced:
- `dashboard/public/index.html`
- `dashboard/src/watcher.ts`
- `dashboard/src/types.ts`

- [ ] **Step 2: Update dashboard scripts**

Ensure `dashboard/package.json` scripts are correct for the new setup. Add a `dev:all` script that starts both Express and Vite dev server.

- [ ] **Step 3: End-to-end smoke test**

Start the full stack and verify:

```bash
# Terminal 1: Start dashboard backend
cd dashboard && npm run dev

# Terminal 2: Start dashboard frontend
cd dashboard/client && npm run dev
```

Open `http://localhost:5173`. Verify:
- Sidebar navigation works
- Dashboard page shows health (or graceful error if signal-cli not running)
- Groups, Reminders, Dossiers etc. load data from DB
- Factory tab renders (empty state if no runs)
- WebSocket connects (check browser console)

- [ ] **Step 4: Build production client**

```bash
cd dashboard/client && npm run build
```

Verify Express serves the built files at `http://localhost:3333`.

- [ ] **Step 5: Run bot test suite to verify no regressions**

```bash
cd bot && npx vitest run
```

Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: cleanup old dashboard files, integration test passes"
```

---

## Notes for Implementer

- **Relative imports for bot code:** The dashboard backend uses relative imports to access bot code (e.g., `import { Storage } from '../../bot/src/storage'`). This works with `tsx` runtime but not with `tsc`. If compiled builds are needed later, switch to npm workspaces.
- **Storage.conn access:** The `DbPoller` needs `storage.conn.db` for direct SQL queries. If `conn` is not public on `Storage`, either make it public or pass `DatabaseConnection` separately to `DbPoller`.
- **signal-cli RPC method names:** The exact method names (`listGroups`, `getGroup`, `quitGroup`) should be verified against the signal-cli JSON-RPC documentation. The bot's existing code uses `listGroups` in `waitForReady()`, so that one is confirmed.
- **CSS approach:** The plan uses a single `App.css` file for simplicity. If the CSS grows unwieldy, consider CSS modules or splitting per-component.
- **Error boundaries:** Consider adding React error boundaries around each page to prevent one broken page from crashing the entire app.
