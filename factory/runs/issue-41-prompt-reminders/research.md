# Research: Issue #41 -- One-off Reminders Prompt Mode

## 1. SQLite Migration: Adding a Column with Default Value

### How better-sqlite3 handles ALTER TABLE ADD COLUMN

SQLite (and by extension better-sqlite3) supports `ALTER TABLE ... ADD COLUMN` with the following constraints:

- The new column **cannot** have a `PRIMARY KEY` or `UNIQUE` constraint.
- The new column **can** have a `DEFAULT` value. If provided, existing rows get that default. If omitted, existing rows get `NULL`.
- The new column **cannot** have `NOT NULL` without a default value (since existing rows would violate the constraint).
- `ALTER TABLE ADD COLUMN` is **instantaneous** regardless of table size -- SQLite only modifies the schema, not the data.

### Established Migration Pattern in This Codebase

The project uses a versioned migration system in `/home/zknowles/personal/signal-bot/bot/src/db.ts`:

```typescript
private runMigrations(): void {
  const currentVersion = this.getSchemaVersion();
  if (currentVersion < 1) { this.migrateToV1(); this.setSchemaVersion(1); }
  if (currentVersion < 2) { this.migrateToV2(); this.setSchemaVersion(2); }
  // ... up to v5 currently
}
```

**Key conventions:**
1. Each migration is a private method `migrateToVN()`.
2. Version is tracked in `schema_meta` table (`key='schema_version'`).
3. For adding columns, the pattern checks `pragma('table_info(table)')` first to make it idempotent:

```typescript
private migrateToV2(): void {
  const cols = this.db.pragma('table_info(reminders)') as Array<{ name: string }>;
  const colNames = cols.map(c => c.name);
  if (!colNames.includes('lastAttemptAt')) {
    this.db.exec('ALTER TABLE reminders ADD COLUMN lastAttemptAt INTEGER');
  }
  if (!colNames.includes('failureReason')) {
    this.db.exec('ALTER TABLE reminders ADD COLUMN failureReason TEXT');
  }
}
```

4. For new tables, `CREATE TABLE IF NOT EXISTS` provides idempotency (see v3, v4, v5).

### Recommendation for the `mode` Column

The new column needs to go on the `reminders` table. A `TEXT` column with a default of `'simple'` is the right approach:

```sql
ALTER TABLE reminders ADD COLUMN mode TEXT NOT NULL DEFAULT 'simple'
```

**Important:** SQLite allows `NOT NULL DEFAULT 'simple'` on `ADD COLUMN` because every existing row gets the default value. This is safe and the column-check idempotency pattern should be used.

This would be migration **v6** in `db.ts`. The `CREATE TABLE` in `initTables()` should also be updated to include the column so fresh databases get it from the start.

### Gotchas

- `better-sqlite3` is **synchronous**. All `db.exec()` and `db.prepare().run()` calls block. No async needed for migrations.
- `ALTER TABLE ADD COLUMN` with a default does NOT rewrite the table -- it only updates the schema. Instantaneous even for large tables.
- The `pragma('table_info(...)')` check is necessary because `ALTER TABLE ADD COLUMN` will throw if the column already exists.


## 2. Reminder Type System

### Current Reminder Interface

```typescript
// bot/src/types.ts
export type ReminderStatus = 'pending' | 'sent' | 'cancelled' | 'failed';

export interface Reminder {
  id: number;
  groupId: string;
  requester: string;
  reminderText: string;
  dueAt: number;
  status: ReminderStatus;
  retryCount: number;
  createdAt: number;
  sentAt: number | null;
  lastAttemptAt: number | null;
  failureReason: string | null;
}
```

A `mode` field needs to be added:

```typescript
export type ReminderMode = 'simple' | 'prompt';

export interface Reminder {
  // ... existing fields ...
  mode: ReminderMode;
}
```

### Current ReminderStore Prepared Statements

The `ReminderStore` (`bot/src/stores/reminderStore.ts`) uses prepared statements cached in the constructor. The `insert` statement needs updating to accept the `mode` parameter:

```typescript
// Current:
INSERT INTO reminders (groupId, requester, reminderText, dueAt, status, retryCount, createdAt)
VALUES (?, ?, ?, ?, 'pending', 0, ?)

// Needs to become:
INSERT INTO reminders (groupId, requester, reminderText, dueAt, status, retryCount, createdAt, mode)
VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)
```

The `create()` method signature changes from:
```typescript
create(groupId, requester, reminderText, dueAt): number
```
to:
```typescript
create(groupId, requester, reminderText, dueAt, mode?: ReminderMode): number
```

Making `mode` optional with default `'simple'` preserves backward compatibility.


## 3. ReminderScheduler: Current Architecture

### One-off Reminder Flow (current)

`ReminderScheduler.processReminder()` in `bot/src/reminderScheduler.ts`:

1. Staleness check (>24h overdue -> mark failed)
2. Max retries check (>=3 -> mark failed)
3. Exponential backoff check
4. `recordAttempt()` -- claim-then-send pattern
5. Format message: `"Reminder: {text}"`
6. `signalClient.sendMessage(groupId, message)` -- direct text send
7. `markSent()`

### Recurring Reminder Flow (the model to follow)

`ReminderScheduler.processRecurringReminders()`:

1. `store.markInFlight(id)` -- claim
2. `executor.execute(reminder)` -- spawns Claude CLI
3. `store.markFired(id, nextDueAt)` -- advance schedule
4. On failure: `advanceNextDue()` + `incrementFailures()`

The `RecurringReminderExecutor` (`bot/src/recurringReminderExecutor.ts`) is the key reference:

```typescript
async execute(reminder: RecurringReminder): Promise<void> {
  const mcpConfig = buildMcpConfig(context);
  const args = [
    '-p', reminder.promptText,
    '--output-format', 'json',
    '--max-turns', String(this.maxTurns),
    '--no-session-persistence',
    '--allowedTools', buildAllowedTools(),
    '--mcp-config', JSON.stringify(mcpConfig),
    '--strict-mcp-config',
    '--system-prompt', systemPrompt,
    '--agents', agentsConfig,
  ];

  const { stdout } = await spawnPromise('claude', args, {
    timeout: 300000,
    env: { ...process.env, CLAUDECODE: '' },
  });

  const response = parseClaudeOutput(stdout);
  if (!response.sentViaMcp) {
    await this.signalClient.sendMessage(reminder.groupId, response.content);
  }
}
```

### What Needs to Change for Prompt Mode

The `processReminder()` method needs a branch:

```
if (reminder.mode === 'prompt') {
  // Use RecurringReminderExecutor-like spawning (or a shared executor)
} else {
  // Current simple text-send path
}
```

The `RecurringReminderExecutor` can likely be reused directly since it already:
- Builds MCP config with all tools
- Spawns `claude -p` with the prompt text
- Parses output and sends via MCP or fallback
- Handles timeouts

The executor needs the `AppConfig` (for MCP config building) and `SignalClient` (for fallback sends). Both are already available in `ReminderScheduler` or can be injected.


## 4. Child Process Spawning: node:child_process API

### spawn() API (used in this project)

```typescript
import { spawn } from 'node:child_process';

const child = spawn(command, args, {
  env: options.env,        // environment variables
  stdio: ['pipe', 'pipe', 'pipe'],  // stdin, stdout, stderr
});
```

The project's `spawnPromise()` wrapper in `bot/src/claudeClient.ts` handles:
- Collecting stdout chunks into a Buffer
- Collecting stderr as string
- Optional timeout via `setTimeout` + `child.kill()`
- Resolving on `close` with code 0, rejecting otherwise
- Rejecting on `error` event

### Key spawn() Behaviors

- `child.stdin.end()` -- must close stdin or the child may hang waiting for input
- `child.stdout.on('data', ...)` -- data arrives in chunks (Buffer), must be concatenated
- `child.on('close', code)` -- fires when process exits and all stdio streams are closed
- `child.on('error', err)` -- fires when process cannot be spawned (e.g., ENOENT)
- `child.kill()` -- sends SIGTERM by default

### Environment Variable Isolation

The project explicitly sets `CLAUDECODE: ''` to prevent nested Claude sessions from interfering:
```typescript
env: { ...process.env, CLAUDECODE: '' }
```


## 5. Testing Patterns

### Mocking child_process.spawn (from claudeClient.test.ts)

The project uses `vi.hoisted()` + `vi.mock()` to mock spawn:

```typescript
const { mockSpawn } = vi.hoisted(() => {
  const mockSpawn = vi.fn();
  return { mockSpawn };
});

vi.mock('child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: mockSpawn };
});
```

**Helper factories for mock child processes:**

```typescript
function createMockChild() {
  const child = Object.assign(new EventEmitter(), {
    stdin: { end: vi.fn() },
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
  });
  return child;
}

function mockSpawnSuccess(stdout: string) {
  mockSpawn.mockImplementation(() => {
    const child = createMockChild();
    process.nextTick(() => {
      child.stdout.emit('data', Buffer.from(stdout));
      child.emit('close', 0);
    });
    return child;
  });
}
```

### Mocking Store Dependencies (from reminderScheduler.test.ts)

Stores and clients are mocked as plain objects with `vi.fn()`:

```typescript
function createMockStore() {
  return {
    getGroupsWithDueReminders: vi.fn().mockReturnValue([]),
    getDueByGroup: vi.fn().mockReturnValue([]),
    recordAttempt: vi.fn(),
    markSent: vi.fn().mockReturnValue(true),
    markFailed: vi.fn().mockReturnValue(true),
    // ...
  };
}

// Used with `as any` cast:
scheduler = new ReminderScheduler(mockStore as any, mockSignalClient as any);
```

### Mocking Module Dependencies

The logger is always mocked to suppress output:
```typescript
vi.mock('../src/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), step: vi.fn(), ... },
}));
```

Utility modules can be mocked too:
```typescript
vi.mock('../src/utils/cron', () => ({
  computeNextDue: vi.fn().mockReturnValue(9999999999999),
}));
```

### Testing Real SQLite (from store tests)

Store tests use real SQLite via `createTestDb()`:
```typescript
import { createTestDb, type TestDb } from '../helpers/testDb';

let db: TestDb;
let store: ReminderStore;

const setup = () => {
  db = createTestDb('signal-bot-reminder-store-test-');
  store = new ReminderStore(db.conn);
};

afterEach(() => { db?.cleanup(); });
```

This creates a temp directory with a real SQLite database, runs all migrations, and cleans up after each test.

### Test File for the New Prompt Mode Feature

Tests will likely be needed in:

1. **`tests/stores/reminderStore.test.ts`** -- Test that `create()` accepts and stores `mode`, defaults to `'simple'`.
2. **`tests/db.test.ts`** -- Test v6 migration adds the `mode` column, preserves existing data with `'simple'` default.
3. **`tests/reminderScheduler.test.ts`** -- Test that `mode='simple'` reminders follow existing path; `mode='prompt'` reminders spawn a Claude session.
4. **`tests/reminderMcpServer.test.ts`** -- Test that the MCP tool accepts the `mode` parameter.


## 6. MCP Server: set_reminder Tool

The `set_reminder` tool in `bot/src/mcp/servers/reminders.ts` needs a new optional `mode` parameter:

```typescript
{
  name: 'set_reminder',
  inputSchema: {
    type: 'object',
    properties: {
      reminderText: { type: 'string', description: '...' },
      dueAt: { type: 'number', description: '...' },
      mode: {
        type: 'string',
        enum: ['simple', 'prompt'],
        description: 'Mode: "simple" sends the text directly, "prompt" spawns a Claude session with MCP tools',
      },
    },
    required: ['reminderText', 'dueAt'],
  },
}
```

The handler calls `store.create(groupId, sender, reminderText, dueAt, mode)`.


## 7. Summary of Files to Modify

| File | Change |
|------|--------|
| `bot/src/types.ts` | Add `ReminderMode` type, add `mode` field to `Reminder` |
| `bot/src/db.ts` | Add `mode` column to `initTables()` CREATE TABLE, add `migrateToV6()` |
| `bot/src/stores/reminderStore.ts` | Update `insert` statement and `create()` signature, update `mapReminderRow()` |
| `bot/src/reminderScheduler.ts` | Branch on `mode` in `processReminder()`, inject executor dependency |
| `bot/src/mcp/servers/reminders.ts` | Add `mode` parameter to `set_reminder` tool schema and handler |
| `bot/tests/db.test.ts` | Test v6 migration |
| `bot/tests/stores/reminderStore.test.ts` | Test mode field storage and default |
| `bot/tests/reminderScheduler.test.ts` | Test prompt mode branching |
| `bot/tests/reminderMcpServer.test.ts` | Test mode parameter acceptance |
