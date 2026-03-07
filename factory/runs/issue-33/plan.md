# Recurring Reminders Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add recurring/repeating reminders with cron scheduling that trigger full Claude CLI invocations with all MCP tools.

**Architecture:** New `recurring_reminders` table with cron expressions and pre-computed `nextDueAt`. Scheduler polls every 30s, claims due reminders with in-flight guard (7min timeout), spawns Claude CLI with full MCP config. Separate lifecycle from one-shot reminders (active/cancelled vs pending→sent). Auto-cancels after 5 consecutive failures. Processes max 1 recurring per group per tick to avoid blocking the polling loop.

**Tech Stack:** croner (zero-dep cron parser), better-sqlite3, Claude CLI (`claude -p`)

---

### Task 1: Install croner + create cron utility

**Files:**
- Modify: `bot/package.json`
- Create: `bot/src/utils/cron.ts`
- Create: `bot/tests/utils/cron.test.ts`

**Step 1: Install croner**

Run: `cd bot && npm install croner`

**Step 2: Write failing tests for cron utility**

```typescript
// bot/tests/utils/cron.test.ts
import { describe, expect, it } from 'vitest';
import { computeNextDue, describeCron, isValidCron } from '../../src/utils/cron';

describe('cron utils', () => {
  describe('isValidCron', () => {
    it('should accept valid 5-field cron expressions', () => {
      expect(isValidCron('0 8 * * *')).toBe(true);     // daily 8am
      expect(isValidCron('0 16 * * 2')).toBe(true);    // tuesday 4pm
      expect(isValidCron('*/15 * * * *')).toBe(true);  // every 15 min
      expect(isValidCron('0 9 * * 1-5')).toBe(true);   // weekdays 9am
    });

    it('should reject invalid expressions', () => {
      expect(isValidCron('not a cron')).toBe(false);
      expect(isValidCron('')).toBe(false);
      expect(isValidCron('60 * * * *')).toBe(false); // minute out of range
    });
  });

  describe('computeNextDue', () => {
    it('should return a future timestamp', () => {
      const now = Date.now();
      const next = computeNextDue('* * * * *', 'Australia/Sydney');
      expect(next).toBeGreaterThan(now - 1000); // within tolerance
    });

    it('should compute next occurrence after a given date', () => {
      // Daily at 8am — after 2026-01-15 07:00 Sydney time, next should be 2026-01-15 08:00
      const after = new Date('2026-01-15T07:00:00+11:00'); // 7am AEDT
      const next = computeNextDue('0 8 * * *', 'Australia/Sydney', after);
      const nextDate = new Date(next);
      expect(nextDate.getTime()).toBeGreaterThan(after.getTime());
    });

    it('should respect timezone', () => {
      const after = new Date('2026-01-15T00:00:00Z');
      const sydneyNext = computeNextDue('0 8 * * *', 'Australia/Sydney', after);
      const londonNext = computeNextDue('0 8 * * *', 'Europe/London', after);
      expect(sydneyNext).not.toBe(londonNext);
    });
  });

  describe('describeCron', () => {
    it('should return formatted next occurrences', () => {
      const desc = describeCron('0 8 * * *', 'Australia/Sydney');
      expect(desc).toContain('8:00');
      expect(desc.split('\n').length).toBe(3); // 3 lines for 3 occurrences
    });
  });
});
```

**Step 3: Run tests to verify they fail**

Run: `cd bot && npx vitest run tests/utils/cron.test.ts`
Expected: FAIL — module not found

**Step 4: Implement cron utility**

```typescript
// bot/src/utils/cron.ts
import { Cron } from 'croner';

export function computeNextDue(cronExpression: string, timezone: string, after?: Date): number {
  const job = new Cron(cronExpression, { timezone });
  const next = job.nextRun(after || new Date());
  if (!next) {
    throw new Error(`No next occurrence for cron expression: ${cronExpression}`);
  }
  return next.getTime();
}

export function isValidCron(cronExpression: string): boolean {
  try {
    new Cron(cronExpression);
    return true;
  } catch {
    return false;
  }
}

export function describeCron(cronExpression: string, timezone: string): string {
  const job = new Cron(cronExpression, { timezone });
  const lines: string[] = [];
  let current: Date | undefined;
  for (let i = 0; i < 3; i++) {
    current = job.nextRun(current) || undefined;
    if (!current) break;
    lines.push(current.toLocaleString('en-AU', { timeZone: timezone }));
  }
  return lines.join('\n');
}
```

**Step 5: Run tests to verify they pass**

Run: `cd bot && npx vitest run tests/utils/cron.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add bot/src/utils/cron.ts bot/tests/utils/cron.test.ts bot/package.json bot/package-lock.json
git commit -m "feat: add cron utility with croner library (#33)"
```

---

### Task 2: Add types + V5 migration

**Files:**
- Modify: `bot/src/types.ts` (add after line 37)
- Modify: `bot/src/db.ts` (add V5 migration)

**Step 1: Add RecurringReminder types**

Add to `bot/src/types.ts` after the `Reminder` interface (after line 37):

```typescript
export type RecurringReminderStatus = 'active' | 'cancelled';

export interface RecurringReminder {
  id: number;
  groupId: string;
  requester: string;
  promptText: string;
  cronExpression: string;
  timezone: string;
  nextDueAt: number;
  status: RecurringReminderStatus;
  consecutiveFailures: number;
  lastFiredAt: number | null;
  lastInFlightAt: number | null;
  createdAt: number;
  updatedAt: number;
}
```

**Step 2: Add V5 migration to `bot/src/db.ts`**

Add `migrateToV5()` method:

```typescript
private migrateToV5(): void {
  this.db.exec(`
    CREATE TABLE IF NOT EXISTS recurring_reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      groupId TEXT NOT NULL,
      requester TEXT NOT NULL,
      promptText TEXT NOT NULL,
      cronExpression TEXT NOT NULL,
      timezone TEXT NOT NULL,
      nextDueAt INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      consecutiveFailures INTEGER NOT NULL DEFAULT 0,
      lastFiredAt INTEGER,
      lastInFlightAt INTEGER,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_recurring_status_due
    ON recurring_reminders(status, nextDueAt);

    CREATE INDEX IF NOT EXISTS idx_recurring_group
    ON recurring_reminders(groupId, status);
  `);
}
```

Add to `runMigrations()`:

```typescript
if (currentVersion < 5) {
  this.migrateToV5();
  this.setSchemaVersion(5);
}
```

**Step 3: Verify migration works**

Run: `cd bot && npx vitest run tests/stores/reminderStore.test.ts`
Expected: PASS (existing tests still work with new migration)

**Step 4: Commit**

```bash
git add bot/src/types.ts bot/src/db.ts
git commit -m "feat: add recurring_reminders table and types (#33)"
```

---

### Task 3: Create RecurringReminderStore

**Files:**
- Create: `bot/src/stores/recurringReminderStore.ts`
- Create: `bot/tests/stores/recurringReminderStore.test.ts`

**Step 1: Write failing tests**

```typescript
// bot/tests/stores/recurringReminderStore.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RecurringReminderStore } from '../../src/stores/recurringReminderStore';
import { type TestDb, createTestDb } from '../helpers/testDb';

describe('RecurringReminderStore', () => {
  let testDb: TestDb;
  let store: RecurringReminderStore;

  beforeEach(() => {
    testDb = createTestDb();
    store = new RecurringReminderStore(testDb.conn);
  });

  afterEach(() => {
    testDb.cleanup();
  });

  describe('create', () => {
    it('should create a recurring reminder and return its id', () => {
      const id = store.create('group1', '+61400000000', 'Check weather', '0 8 * * *', 'Australia/Sydney', Date.now() + 60000);
      expect(id).toBe(1);
    });

    it('should reject empty groupId', () => {
      expect(() => store.create('', '+61400000000', 'text', '0 8 * * *', 'Australia/Sydney', Date.now())).toThrow('groupId');
    });

    it('should reject empty promptText', () => {
      expect(() => store.create('group1', '+61400000000', '', '0 8 * * *', 'Australia/Sydney', Date.now())).toThrow('promptText');
    });
  });

  describe('getGroupsWithDue', () => {
    it('should return groups with due recurring reminders', () => {
      const past = Date.now() - 1000;
      store.create('group1', 'user', 'text', '0 8 * * *', 'Australia/Sydney', past);
      store.create('group2', 'user', 'text', '0 8 * * *', 'Australia/Sydney', past);
      const groups = store.getGroupsWithDue(Date.now());
      expect(groups).toContain('group1');
      expect(groups).toContain('group2');
    });

    it('should not return groups with only future reminders', () => {
      const future = Date.now() + 60000;
      store.create('group1', 'user', 'text', '0 8 * * *', 'Australia/Sydney', future);
      expect(store.getGroupsWithDue(Date.now())).toHaveLength(0);
    });
  });

  describe('getDueByGroup', () => {
    it('should return due reminders for a group', () => {
      const past = Date.now() - 1000;
      store.create('group1', 'user', 'text', '0 8 * * *', 'Australia/Sydney', past);
      const due = store.getDueByGroup('group1', Date.now(), 10);
      expect(due).toHaveLength(1);
      expect(due[0].promptText).toBe('text');
    });

    it('should skip reminders with recent lastInFlightAt', () => {
      const past = Date.now() - 1000;
      const id = store.create('group1', 'user', 'text', '0 8 * * *', 'Australia/Sydney', past);
      store.markInFlight(id);
      const due = store.getDueByGroup('group1', Date.now(), 10);
      expect(due).toHaveLength(0);
    });

    it('should include reminders with expired lastInFlightAt (>7 min)', () => {
      const past = Date.now() - 1000;
      const id = store.create('group1', 'user', 'text', '0 8 * * *', 'Australia/Sydney', past);
      // Manually set lastInFlightAt to 8 minutes ago (exceeds 7 min timeout)
      testDb.conn.db.prepare('UPDATE recurring_reminders SET lastInFlightAt = ? WHERE id = ?').run(Date.now() - 8 * 60 * 1000, id);
      const due = store.getDueByGroup('group1', Date.now(), 10);
      expect(due).toHaveLength(1);
    });
  });

  describe('markInFlight', () => {
    it('should claim a reminder', () => {
      const id = store.create('group1', 'user', 'text', '0 8 * * *', 'Australia/Sydney', Date.now() - 1000);
      expect(store.markInFlight(id)).toBe(true);
    });

    it('should reject double claim', () => {
      const id = store.create('group1', 'user', 'text', '0 8 * * *', 'Australia/Sydney', Date.now() - 1000);
      store.markInFlight(id);
      expect(store.markInFlight(id)).toBe(false);
    });
  });

  describe('markFired', () => {
    it('should advance nextDueAt and clear lastInFlightAt', () => {
      const id = store.create('group1', 'user', 'text', '0 8 * * *', 'Australia/Sydney', Date.now() - 1000);
      store.markInFlight(id);
      const nextDue = Date.now() + 86400000;
      store.markFired(id, nextDue);

      const reminders = store.listActive('group1');
      expect(reminders[0].nextDueAt).toBe(nextDue);
      expect(reminders[0].lastFiredAt).not.toBeNull();
      expect(reminders[0].lastInFlightAt).toBeNull();
    });
  });

  describe('clearInFlight', () => {
    it('should release the in-flight claim', () => {
      const id = store.create('group1', 'user', 'text', '0 8 * * *', 'Australia/Sydney', Date.now() - 1000);
      store.markInFlight(id);
      store.clearInFlight(id);
      // Should be claimable again
      expect(store.markInFlight(id)).toBe(true);
    });
  });

  describe('cancel', () => {
    it('should cancel an active reminder', () => {
      const id = store.create('group1', 'user', 'text', '0 8 * * *', 'Australia/Sydney', Date.now());
      expect(store.cancel(id, 'group1')).toBe(true);
      expect(store.listActive('group1')).toHaveLength(0);
    });

    it('should not cancel a reminder from different group', () => {
      const id = store.create('group1', 'user', 'text', '0 8 * * *', 'Australia/Sydney', Date.now());
      expect(store.cancel(id, 'group2')).toBe(false);
    });
  });

  describe('listActive', () => {
    it('should list active reminders', () => {
      store.create('group1', 'user', 'text1', '0 8 * * *', 'Australia/Sydney', Date.now());
      store.create('group1', 'user', 'text2', '0 16 * * 2', 'Australia/Sydney', Date.now());
      const id3 = store.create('group1', 'user', 'text3', '0 9 * * *', 'Australia/Sydney', Date.now());
      store.cancel(id3, 'group1');

      const active = store.listActive('group1');
      expect(active).toHaveLength(2);
    });

    it('should not include cancelled reminders', () => {
      const id = store.create('group1', 'user', 'text', '0 8 * * *', 'Australia/Sydney', Date.now());
      store.cancel(id, 'group1');
      expect(store.listActive('group1')).toHaveLength(0);
    });
  });

  describe('incrementFailures', () => {
    it('should increment consecutive failure count', () => {
      const id = store.create('group1', 'user', 'text', '0 8 * * *', 'Australia/Sydney', Date.now());
      expect(store.incrementFailures(id)).toBe(1);
      expect(store.incrementFailures(id)).toBe(2);
    });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd bot && npx vitest run tests/stores/recurringReminderStore.test.ts`
Expected: FAIL — module not found

**Step 3: Implement RecurringReminderStore**

```typescript
// bot/src/stores/recurringReminderStore.ts
import type Database from 'better-sqlite3';
import type { DatabaseConnection } from '../db';
import { wrapSqliteError } from '../db';
import type { RecurringReminder, RecurringReminderStatus } from '../types';

const IN_FLIGHT_TIMEOUT_MS = 7 * 60 * 1000; // 7 minutes (must exceed Claude CLI 5min spawn timeout)
const MAX_CONSECUTIVE_FAILURES = 5;

type RecurringReminderRow = Omit<RecurringReminder, 'status'> & { status: string };

function mapRow(row: RecurringReminderRow): RecurringReminder {
  return { ...row, status: row.status as RecurringReminderStatus };
}

export class RecurringReminderStore {
  private conn: DatabaseConnection;
  private stmts: {
    insert: Database.Statement;
    getGroupsWithDue: Database.Statement;
    getDueByGroup: Database.Statement;
    markInFlight: Database.Statement;
    markFired: Database.Statement;
    clearInFlight: Database.Statement;
    cancel: Database.Statement;
    listActive: Database.Statement;
    incrementFailures: Database.Statement;
    resetFailures: Database.Statement;
  };

  constructor(conn: DatabaseConnection) {
    this.conn = conn;
    this.stmts = {
      insert: conn.db.prepare(`
        INSERT INTO recurring_reminders (groupId, requester, promptText, cronExpression, timezone, nextDueAt, status, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
      `),
      getGroupsWithDue: conn.db.prepare(`
        SELECT DISTINCT groupId FROM recurring_reminders
        WHERE status = 'active' AND nextDueAt <= ?
          AND (lastInFlightAt IS NULL OR lastInFlightAt < ?)
      `),
      getDueByGroup: conn.db.prepare(`
        SELECT * FROM recurring_reminders
        WHERE groupId = ? AND status = 'active' AND nextDueAt <= ?
          AND (lastInFlightAt IS NULL OR lastInFlightAt < ?)
        ORDER BY nextDueAt ASC
        LIMIT ?
      `),
      markInFlight: conn.db.prepare(`
        UPDATE recurring_reminders SET lastInFlightAt = ?, updatedAt = ?
        WHERE id = ? AND (lastInFlightAt IS NULL OR lastInFlightAt < ?)
      `),
      markFired: conn.db.prepare(`
        UPDATE recurring_reminders SET lastFiredAt = ?, lastInFlightAt = NULL, nextDueAt = ?, updatedAt = ?
        WHERE id = ?
      `),
      clearInFlight: conn.db.prepare(`
        UPDATE recurring_reminders SET lastInFlightAt = NULL, updatedAt = ?
        WHERE id = ?
      `),
      cancel: conn.db.prepare(`
        UPDATE recurring_reminders SET status = 'cancelled', updatedAt = ?
        WHERE id = ? AND groupId = ? AND status != 'cancelled'
      `),
      listActive: conn.db.prepare(`
        SELECT * FROM recurring_reminders
        WHERE groupId = ? AND status != 'cancelled'
        ORDER BY nextDueAt ASC
      `),
      incrementFailures: conn.db.prepare(`
        UPDATE recurring_reminders SET consecutiveFailures = consecutiveFailures + 1, updatedAt = ?
        WHERE id = ?
      `),
      resetFailures: conn.db.prepare(`
        UPDATE recurring_reminders SET consecutiveFailures = 0, updatedAt = ?
        WHERE id = ?
      `),
    };
  }

  create(groupId: string, requester: string, promptText: string, cronExpression: string, timezone: string, nextDueAt: number): number {
    this.conn.ensureOpen();
    if (!groupId || groupId.trim() === '') throw new Error('Invalid groupId: cannot be empty');
    if (!promptText || promptText.trim() === '') throw new Error('Invalid promptText: cannot be empty');

    try {
      const now = Date.now();
      const result = this.stmts.insert.run(groupId, requester, promptText, cronExpression, timezone, nextDueAt, now, now);
      return Number(result.lastInsertRowid);
    } catch (error) {
      wrapSqliteError(error, 'create recurring reminder');
    }
  }

  getGroupsWithDue(now: number): string[] {
    return this.conn.runOp('get groups with due recurring reminders', () => {
      const cutoff = now - IN_FLIGHT_TIMEOUT_MS;
      const rows = this.stmts.getGroupsWithDue.all(now, cutoff) as Array<{ groupId: string }>;
      return rows.map(r => r.groupId);
    });
  }

  getDueByGroup(groupId: string, now: number, limit: number): RecurringReminder[] {
    return this.conn.runOp('get due recurring reminders by group', () => {
      const cutoff = now - IN_FLIGHT_TIMEOUT_MS;
      const rows = this.stmts.getDueByGroup.all(groupId, now, cutoff, limit) as RecurringReminderRow[];
      return rows.map(mapRow);
    });
  }

  markInFlight(id: number): boolean {
    return this.conn.runOp('mark recurring reminder in-flight', () => {
      const now = Date.now();
      const cutoff = now - IN_FLIGHT_TIMEOUT_MS;
      const result = this.stmts.markInFlight.run(now, now, id, cutoff);
      return result.changes > 0;
    });
  }

  markFired(id: number, nextDueAt: number): boolean {
    return this.conn.runOp('mark recurring reminder fired', () => {
      const now = Date.now();
      this.stmts.resetFailures.run(now, id);
      const result = this.stmts.markFired.run(now, nextDueAt, now, id);
      return result.changes > 0;
    });
  }

  incrementFailures(id: number): number {
    return this.conn.runOp('increment recurring reminder failures', () => {
      this.stmts.incrementFailures.run(Date.now(), id);
      const row = this.conn.db.prepare('SELECT consecutiveFailures FROM recurring_reminders WHERE id = ?').get(id) as { consecutiveFailures: number } | undefined;
      return row?.consecutiveFailures ?? 0;
    });
  }

  clearInFlight(id: number): void {
    this.conn.runOp('clear recurring reminder in-flight', () => {
      this.stmts.clearInFlight.run(Date.now(), id);
    });
  }

  cancel(id: number, groupId: string): boolean {
    return this.conn.runOp('cancel recurring reminder', () => {
      const result = this.stmts.cancel.run(Date.now(), id, groupId);
      return result.changes > 0;
    });
  }

  listActive(groupId: string): RecurringReminder[] {
    return this.conn.runOp('list active recurring reminders', () => {
      const rows = this.stmts.listActive.all(groupId) as RecurringReminderRow[];
      return rows.map(mapRow);
    });
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `cd bot && npx vitest run tests/stores/recurringReminderStore.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add bot/src/stores/recurringReminderStore.ts bot/tests/stores/recurringReminderStore.test.ts
git commit -m "feat: add RecurringReminderStore with in-flight guards (#33)"
```

---

### Task 4: Export spawnPromise + create RecurringReminderExecutor

**Files:**
- Modify: `bot/src/claudeClient.ts` (export `spawnPromise` and `parseClaudeOutput`)
- Create: `bot/src/recurringReminderExecutor.ts`
- Create: `bot/tests/recurringReminderExecutor.test.ts`

**Step 1: Export spawnPromise from claudeClient.ts**

Change line 25 from `function spawnPromise(` to `export function spawnPromise(`. The function is already exported via `parseClaudeOutput` — just add the `export` keyword to `spawnPromise`.

**Step 2: Write failing tests for executor**

```typescript
// bot/tests/recurringReminderExecutor.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RecurringReminderExecutor } from '../src/recurringReminderExecutor';
import type { RecurringReminder } from '../src/types';

vi.mock('../src/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), step: vi.fn(), debug: vi.fn(), warn: vi.fn(), success: vi.fn(), compact: vi.fn() },
}));

// Mock spawnPromise
vi.mock('../src/claudeClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/claudeClient')>();
  return {
    ...actual,
    spawnPromise: vi.fn().mockResolvedValue({
      stdout: JSON.stringify([
        { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__signal__send_message', input: { message: 'Good morning!' } }] } },
        { type: 'result', result: 'Good morning!', is_error: false, usage: { input_tokens: 100, output_tokens: 50 } },
      ]),
    }),
  };
});

function makeRecurring(overrides: Partial<RecurringReminder> = {}): RecurringReminder {
  return {
    id: 1,
    groupId: 'group1',
    requester: '+61400000000',
    promptText: 'Check the weather and give a morning briefing',
    cronExpression: '0 8 * * *',
    timezone: 'Australia/Sydney',
    nextDueAt: Date.now() - 1000,
    status: 'active',
    lastFiredAt: null,
    lastInFlightAt: null,
    createdAt: Date.now() - 86400000,
    updatedAt: Date.now() - 86400000,
    ...overrides,
  };
}

describe('RecurringReminderExecutor', () => {
  let executor: RecurringReminderExecutor;
  let mockSignalClient: { sendMessage: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.restoreAllMocks();
    mockSignalClient = { sendMessage: vi.fn().mockResolvedValue(undefined) };
    executor = new RecurringReminderExecutor(
      {
        dbPath: './data/test.db',
        timezone: 'Australia/Sydney',
        githubRepo: 'test/repo',
        sourceRoot: '/test',
        signalCliUrl: 'http://localhost:8080',
        botPhoneNumber: '+61400000000',
        attachmentsDir: '/tmp',
        whisperModelPath: '',
      },
      mockSignalClient as any,
      5,
    );
  });

  it('should execute a recurring reminder', async () => {
    const reminder = makeRecurring();
    await executor.execute(reminder);
    // spawnPromise was called (mocked)
    const { spawnPromise } = await import('../src/claudeClient');
    expect(spawnPromise).toHaveBeenCalled();
  });

  it('should send result via signal if not sent via MCP', async () => {
    // Mock response without send_message tool call
    const { spawnPromise } = await import('../src/claudeClient');
    (spawnPromise as ReturnType<typeof vi.fn>).mockResolvedValue({
      stdout: JSON.stringify([
        { type: 'result', result: 'Here is your briefing', is_error: false, usage: {} },
      ]),
    });

    const reminder = makeRecurring();
    await executor.execute(reminder);
    expect(mockSignalClient.sendMessage).toHaveBeenCalledWith('group1', 'Here is your briefing');
  });

  it('should not send via signal if already sent via MCP send_message', async () => {
    const reminder = makeRecurring();
    await executor.execute(reminder);
    // Response was sent via MCP, so signalClient should NOT be called
    expect(mockSignalClient.sendMessage).not.toHaveBeenCalled();
  });
});
```

**Step 3: Run tests to verify they fail**

Run: `cd bot && npx vitest run tests/recurringReminderExecutor.test.ts`
Expected: FAIL — module not found

**Step 4: Implement RecurringReminderExecutor**

```typescript
// bot/src/recurringReminderExecutor.ts
import { logger } from './logger';
import { parseClaudeOutput, spawnPromise } from './claudeClient';
import { buildAllowedTools, buildMcpConfig } from './mcp/registry';
import type { SignalClient } from './signalClient';
import type { AppConfig, RecurringReminder } from './types';

export class RecurringReminderExecutor {
  private appConfig: AppConfig;
  private signalClient: SignalClient;
  private maxTurns: number;

  constructor(appConfig: AppConfig, signalClient: SignalClient, maxTurns: number) {
    this.appConfig = appConfig;
    this.signalClient = signalClient;
    this.maxTurns = maxTurns;
  }

  async execute(reminder: RecurringReminder): Promise<void> {
    const context = {
      ...this.appConfig,
      groupId: reminder.groupId,
      sender: reminder.requester,
    };

    const systemPrompt = [
      `You are a helpful assistant in a Signal group chat. A recurring reminder has fired.`,
      `Process the following instruction and send your response to the group using the send_message tool.`,
      `Current time: ${new Date().toISOString()}`,
      `Timezone: ${reminder.timezone}`,
      `Group ID: ${reminder.groupId}`,
    ].join('\n');

    const mcpConfig = buildMcpConfig(context);
    const agentsConfig = JSON.stringify({
      'message-historian': {
        description: 'Searches and summarizes historical messages from this group chat.',
        prompt: `You search through chat history and return concise summaries. Use search_messages for keyword lookups and get_messages_by_date for date ranges. Timezone: ${reminder.timezone}`,
        tools: ['mcp__history__search_messages', 'mcp__history__get_messages_by_date'],
        model: 'haiku',
      },
    });

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

    logger.step(`recurring: executing reminder #${reminder.id}: "${reminder.promptText.substring(0, 60)}"`);

    const { stdout } = await spawnPromise('claude', args, {
      timeout: 300000,
      env: { ...process.env, CLAUDECODE: '' },
    });

    const response = parseClaudeOutput(stdout);

    // If Claude didn't use send_message, send the result text directly
    if (!response.sentViaMcp) {
      await this.signalClient.sendMessage(reminder.groupId, response.content);
    }

    logger.step(`recurring: reminder #${reminder.id} completed (${response.sentViaMcp ? 'via MCP' : 'direct send'})`);
  }
}
```

**Step 5: Run tests to verify they pass**

Run: `cd bot && npx vitest run tests/recurringReminderExecutor.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add bot/src/claudeClient.ts bot/src/recurringReminderExecutor.ts bot/tests/recurringReminderExecutor.test.ts
git commit -m "feat: add RecurringReminderExecutor for Claude CLI invocation (#33)"
```

---

### Task 5: Extend ReminderScheduler with recurring support

**Files:**
- Modify: `bot/src/reminderScheduler.ts`
- Create: `bot/tests/reminderScheduler.recurring.test.ts`

**Step 1: Write failing tests**

```typescript
// bot/tests/reminderScheduler.recurring.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReminderScheduler } from '../src/reminderScheduler';

vi.mock('../src/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), step: vi.fn(), debug: vi.fn(), warn: vi.fn(), success: vi.fn(), compact: vi.fn(), group: vi.fn(), groupEnd: vi.fn() },
}));

vi.mock('../src/utils/cron', () => ({
  computeNextDue: vi.fn().mockReturnValue(Date.now() + 86400000),
}));

function createMockOneShot() {
  return {
    getGroupsWithDueReminders: vi.fn().mockReturnValue([]),
    getDueByGroup: vi.fn().mockReturnValue([]),
    recordAttempt: vi.fn(),
    markSent: vi.fn(),
    markFailed: vi.fn(),
  };
}

function createMockRecurringStore() {
  return {
    getGroupsWithDue: vi.fn().mockReturnValue([]),
    getDueByGroup: vi.fn().mockReturnValue([]),
    markInFlight: vi.fn().mockReturnValue(true),
    markFired: vi.fn().mockReturnValue(true),
    clearInFlight: vi.fn(),
  };
}

function createMockExecutor() {
  return { execute: vi.fn().mockResolvedValue(undefined) };
}

function createMockSignal() {
  return { sendMessage: vi.fn().mockResolvedValue(undefined) };
}

describe('ReminderScheduler - recurring', () => {
  let mockOneShot: ReturnType<typeof createMockOneShot>;
  let mockRecurring: ReturnType<typeof createMockRecurringStore>;
  let mockExecutor: ReturnType<typeof createMockExecutor>;
  let scheduler: ReminderScheduler;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockOneShot = createMockOneShot();
    mockRecurring = createMockRecurringStore();
    mockExecutor = createMockExecutor();
    scheduler = new ReminderScheduler(mockOneShot as any, createMockSignal() as any, mockRecurring as any, mockExecutor as any);
  });

  it('should process recurring reminders alongside one-shot', async () => {
    mockRecurring.getGroupsWithDue.mockReturnValue(['group1']);
    mockRecurring.getDueByGroup.mockReturnValue([{
      id: 1, groupId: 'group1', promptText: 'test', cronExpression: '0 8 * * *', timezone: 'Australia/Sydney',
    }]);

    await scheduler.processDueReminders();

    expect(mockRecurring.markInFlight).toHaveBeenCalledWith(1);
    expect(mockExecutor.execute).toHaveBeenCalled();
    expect(mockRecurring.markFired).toHaveBeenCalled();
  });

  it('should skip if markInFlight returns false (already claimed)', async () => {
    mockRecurring.getGroupsWithDue.mockReturnValue(['group1']);
    mockRecurring.getDueByGroup.mockReturnValue([{
      id: 1, groupId: 'group1', promptText: 'test', cronExpression: '0 8 * * *', timezone: 'Australia/Sydney',
    }]);
    mockRecurring.markInFlight.mockReturnValue(false);

    await scheduler.processDueReminders();
    expect(mockExecutor.execute).not.toHaveBeenCalled();
  });

  it('should clearInFlight on executor failure', async () => {
    mockRecurring.getGroupsWithDue.mockReturnValue(['group1']);
    mockRecurring.getDueByGroup.mockReturnValue([{
      id: 1, groupId: 'group1', promptText: 'test', cronExpression: '0 8 * * *', timezone: 'Australia/Sydney',
    }]);
    mockExecutor.execute.mockRejectedValue(new Error('Claude failed'));

    await scheduler.processDueReminders();
    expect(mockRecurring.clearInFlight).toHaveBeenCalledWith(1);
  });

  it('should work without recurring deps (backward compat)', async () => {
    const simpleScheduler = new ReminderScheduler(mockOneShot as any, createMockSignal() as any);
    await simpleScheduler.processDueReminders();
    // No error thrown
    expect(mockOneShot.getGroupsWithDueReminders).toHaveBeenCalled();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd bot && npx vitest run tests/reminderScheduler.recurring.test.ts`
Expected: FAIL — constructor signature mismatch

**Step 3: Extend ReminderScheduler**

Modify `bot/src/reminderScheduler.ts`:
- Add optional constructor params for `RecurringReminderStore` and `RecurringReminderExecutor`
- Add `processRecurringReminders()` private method
- Call it from `processDueReminders()`

```typescript
// Add imports at top:
import { computeNextDue } from './utils/cron';
import type { RecurringReminderStore } from './stores/recurringReminderStore';
import type { RecurringReminderExecutor } from './recurringReminderExecutor';

// Modify constructor:
constructor(
  private reminderStore: ReminderStore,
  private signalClient: SignalClient,
  private recurringStore?: RecurringReminderStore,
  private recurringExecutor?: RecurringReminderExecutor,
) {}

// Add to processDueReminders() after existing one-shot processing:
if (this.recurringStore && this.recurringExecutor) {
  try {
    total += await this.processRecurringReminders(now);
  } catch (error) {
    logger.error('Error processing recurring reminders:', error);
  }
}

// Add new private method:
private async processRecurringReminders(now: number): Promise<number> {
  const groups = this.recurringStore!.getGroupsWithDue(now);
  let total = 0;
  for (const groupId of groups) {
    // Process at most 1 recurring per group per tick to avoid blocking the polling loop
    const reminders = this.recurringStore!.getDueByGroup(groupId, now, 1);
    for (const reminder of reminders) {
      if (!this.recurringStore!.markInFlight(reminder.id)) continue;
      try {
        await this.recurringExecutor!.execute(reminder);
        const nextDueAt = computeNextDue(reminder.cronExpression, reminder.timezone);
        this.recurringStore!.markFired(reminder.id, nextDueAt);
        total++;
      } catch (error) {
        logger.error(`Recurring reminder ${reminder.id} failed:`, error);
        this.recurringStore!.clearInFlight(reminder.id);
        // Advance to next occurrence to avoid retrying the same missed slot
        try {
          const nextDueAt = computeNextDue(reminder.cronExpression, reminder.timezone);
          this.recurringStore!.markFired(reminder.id, nextDueAt);
          const failures = this.recurringStore!.incrementFailures(reminder.id);
          if (failures >= 5) {
            this.recurringStore!.cancel(reminder.id, reminder.groupId);
            await this.signalClient.sendMessage(reminder.groupId,
              `⚠️ Recurring reminder "${reminder.promptText}" auto-cancelled after ${failures} consecutive failures.`);
          }
        } catch (advanceError) {
          logger.error(`Failed to advance recurring reminder ${reminder.id}:`, advanceError);
        }
      }
    }
  }
  return total;
}
```

**Step 4: Run all scheduler tests**

Run: `cd bot && npx vitest run tests/reminderScheduler`
Expected: PASS (both existing and new tests)

**Step 5: Commit**

```bash
git add bot/src/reminderScheduler.ts bot/tests/reminderScheduler.recurring.test.ts
git commit -m "feat: extend ReminderScheduler with recurring reminder processing (#33)"
```

---

### Task 6: Add MCP tools for recurring reminders

**Files:**
- Modify: `bot/src/mcp/servers/reminders.ts`

**Step 1: Add RecurringReminderStore to onInit and new tools to TOOLS array**

Add to TOOLS array:

```typescript
{
  name: 'set_recurring_reminder',
  title: 'Set Recurring Reminder',
  description: 'Set a recurring reminder using a cron expression. The reminder will trigger a full Claude invocation each time it fires, so it can check weather, summarize reminders, etc. Examples: "0 8 * * *" = daily 8am, "0 16 * * 2" = Tuesday 4pm, "0 9 * * 1-5" = weekdays 9am.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      promptText: { type: 'string', description: 'Instruction for what to do when the reminder fires (e.g., "Check the weather and give a morning briefing")' },
      cronExpression: { type: 'string', description: 'Cron expression (5-field: minute hour day month weekday)' },
    },
    required: ['promptText', 'cronExpression'],
  },
},
{
  name: 'list_recurring_reminders',
  title: 'List Recurring Reminders',
  description: 'List all active recurring reminders for this group.',
  inputSchema: { type: 'object' as const, properties: {} },
},
{
  name: 'cancel_recurring_reminder',
  title: 'Cancel Recurring Reminder',
  description: 'Cancel a recurring reminder by its ID.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      reminderId: { type: 'number', description: 'The ID of the recurring reminder to cancel' },
    },
    required: ['reminderId'],
  },
},
```

Add handlers:

```typescript
set_recurring_reminder(args) {
  const promptText = requireString(args, 'promptText');
  if (promptText.error) return promptText.error;
  const cronExpr = requireString(args, 'cronExpression');
  if (cronExpr.error) return cronExpr.error;
  const groupErr = requireGroupId(groupId);
  if (groupErr) return groupErr;

  if (!isValidCron(cronExpr.value)) {
    return error(`Invalid cron expression: "${cronExpr.value}". Use 5-field format: minute hour day month weekday.`);
  }

  return catchErrors(() => {
    const nextDueAt = computeNextDue(cronExpr.value, tz);
    const id = recurringStore.create(groupId, sender, promptText.value, cronExpr.value, tz, nextDueAt);
    const desc = describeCron(cronExpr.value, tz);
    return ok(`Recurring reminder #${id} set (${cronExpr.value}).\n\nNext 3 occurrences:\n${desc}`);
  }, 'Failed to set recurring reminder');
},

list_recurring_reminders() {
  const groupErr = requireGroupId(groupId);
  if (groupErr) return groupErr;

  const reminders = recurringStore.listActive(groupId);
  if (reminders.length === 0) {
    return ok('No active recurring reminders for this group.');
  }

  const lines = reminders.map(r => {
    const next = new Date(r.nextDueAt).toLocaleString('en-AU', { timeZone: tz });
    return `#${r.id} | ${r.cronExpression} | Next: ${next} | "${r.promptText}" (by ${r.requester})`;
  });
  return ok(`Recurring reminders:\n${lines.join('\n')}`);
},

cancel_recurring_reminder(args) {
  const reminderId = requireNumber(args, 'reminderId');
  if (reminderId.error) return reminderId.error;
  const groupErr = requireGroupId(groupId);
  if (groupErr) return groupErr;

  const success = recurringStore.cancel(reminderId.value, groupId);
  if (success) {
    return ok(`Recurring reminder #${reminderId.value} has been cancelled.`);
  }
  return ok(`Could not cancel recurring reminder #${reminderId.value}. It may not exist, belong to a different group, or already be cancelled.`);
},
```

Add imports and init:
```typescript
// At top:
import { RecurringReminderStore } from '../../stores/recurringReminderStore';
import { computeNextDue, describeCron, isValidCron } from '../../utils/cron';

// Add module-level var:
let recurringStore: RecurringReminderStore;

// In onInit():
recurringStore = new RecurringReminderStore(conn);
```

**Step 2: Run existing reminder MCP tests to verify backward compat**

Run: `cd bot && npx vitest run tests/reminderMcpServer.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add bot/src/mcp/servers/reminders.ts
git commit -m "feat: add set/list/cancel recurring reminder MCP tools (#33)"
```

---

### Task 7: Update Storage facade + wire in index.ts

**Files:**
- Modify: `bot/src/storage.ts`
- Modify: `bot/src/index.ts`

**Step 1: Add RecurringReminderStore to Storage facade**

In `bot/src/storage.ts`:
```typescript
// Add import:
import { RecurringReminderStore } from './stores/recurringReminderStore';

// Add field:
readonly recurringReminders: RecurringReminderStore;

// In constructor, after other store inits:
this.recurringReminders = new RecurringReminderStore(this.conn);
```

**Step 2: Wire up in index.ts**

In `bot/src/index.ts`:
```typescript
// Add import:
import { RecurringReminderExecutor } from './recurringReminderExecutor';

// After signalClient init, before reminderScheduler:
const recurringExecutor = new RecurringReminderExecutor(
  {
    dbPath: config.dbPath,
    timezone: config.timezone,
    githubRepo: config.githubRepo,
    sourceRoot: config.sourceRoot,
    signalCliUrl: config.signalCliUrl,
    botPhoneNumber: config.botPhoneNumber,
    attachmentsDir: config.attachmentsDir,
    whisperModelPath: config.whisperModelPath,
  },
  signalClient,
  config.claude.maxTurns,
);

// Modify reminderScheduler construction:
const reminderScheduler = new ReminderScheduler(
  storage.reminders,
  signalClient,
  storage.recurringReminders,
  recurringExecutor,
);
```

**Step 3: Run all tests**

Run: `cd bot && npx vitest run`
Expected: PASS

**Step 4: Run lint**

Run: `cd bot && npm run check`
Expected: PASS

**Step 5: Commit**

```bash
git add bot/src/storage.ts bot/src/index.ts
git commit -m "feat: wire recurring reminders into app lifecycle (#33)"
```

---

## Verification

1. `cd bot && npx vitest run` — all tests pass
2. `cd bot && npm run check` — lint/format clean
3. Integration test with mock signal server:
   - Start mock: `cd bot && npm run mock-signal`
   - Start bot: `cd bot && npm run dev:test`
   - Send: `claude: set a recurring reminder every minute to say hello`
   - Verify recurring reminder is created
   - Wait ~60s, verify Claude invocation fires and response appears

---

## Revisions (from devil's advocate review)

1. **Removed `paused` status** — YAGNI. Ship with `active | cancelled`. Add pause/resume if users ask.
2. **Increased IN_FLIGHT_TIMEOUT_MS to 7 min** — Must exceed Claude CLI's 5-min spawn timeout to prevent race conditions.
3. **Added `consecutiveFailures` column** — Tracks consecutive failures. After 5 failures, auto-cancels the reminder and notifies the group. Resets to 0 on success.
4. **Limited to 1 recurring per group per tick** — Prevents sequential blocking of the polling loop when multiple reminders fire simultaneously.
5. **Wrapped `processRecurringReminders` in try/catch** — Isolates failures from one-shot reminder processing.
6. **Added `--agents` config to executor** — Enables recurring reminders to use the message-historian subagent for chat summary use cases.
7. **On failure, advance nextDueAt** — Prevents infinite retry of the same missed occurrence.
