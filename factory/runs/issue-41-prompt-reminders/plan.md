# One-off Reminders: Prompt Mode Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `mode` flag to one-off reminders so they can optionally spawn a full Claude session (with MCP tools) instead of just sending a plain text message.

**Architecture:** Add a `mode` column (`'simple' | 'prompt'`) to the `reminders` table with a v6 migration. Extract a `PromptExecution` interface from `RecurringReminderExecutor` so it can accept both `RecurringReminder` and adapted `Reminder` objects. The `ReminderScheduler.processReminder()` method branches on mode — simple reminders send text as before, prompt reminders map to `PromptExecution` and delegate to the already-injected `this.recurringExecutor`. The `set_reminder` MCP tool gains an optional `mode` parameter.

**Tech Stack:** TypeScript, SQLite (better-sqlite3), Vitest, Claude CLI spawning via `node:child_process`

---

### Task 1: Add ReminderMode type and PromptExecution interface

**Files:**
- Modify: `bot/src/types.ts`
- Modify: `bot/src/recurringReminderExecutor.ts`
- Modify: `bot/tests/reminderScheduler.test.ts` (update `makeReminder` helper)
- Modify: `bot/tests/reminderScheduler.recurring.test.ts` (update `makeReminder` helper)
- Test: N/A (type-only changes, verified by compilation in subsequent tasks)

**Step 1: Add types to `bot/src/types.ts`**

After the `Reminder` interface, add:

```typescript
export type ReminderMode = 'simple' | 'prompt';
```

Add `mode` field to the `Reminder` interface, after `failureReason`:

```typescript
  mode: ReminderMode;
```

Add the `PromptExecution` interface (used by the executor). This captures the minimal fields needed to spawn a Claude session:

```typescript
/** Minimal interface for spawning a Claude prompt session. Used by both one-off and recurring reminders. */
export interface PromptExecution {
  id: number;
  groupId: string;
  requester: string;
  promptText: string;
  timezone?: string;
}
```

**Step 2: Update `RecurringReminderExecutor.execute()` to accept `PromptExecution`**

In `bot/src/recurringReminderExecutor.ts` (line 14), change the method signature from:

```typescript
async execute(reminder: RecurringReminder): Promise<void> {
```

to:

```typescript
async execute(reminder: PromptExecution): Promise<void> {
```

Update the import to include `PromptExecution` instead of (or in addition to) `RecurringReminder`.

Update the timezone usage (line 25) to fall back to `this.appConfig.timezone`:

```typescript
`Timezone: ${reminder.timezone ?? this.appConfig.timezone}`,
```

And the agent config timezone (line 34):

```typescript
`... Timezone: ${reminder.timezone ?? this.appConfig.timezone}`,
```

This works because `RecurringReminder` already satisfies `PromptExecution` (it has `id`, `groupId`, `requester`, `promptText`, `timezone`), so no changes are needed at the call site in `reminderScheduler.ts:53`.

**Step 3: Update `makeReminder` helpers in test files**

In `bot/tests/reminderScheduler.test.ts`, find the `makeReminder()` function and add `mode: 'simple' as const` to its default return object.

In `bot/tests/reminderScheduler.recurring.test.ts`, do the same if it has a `makeReminder()` helper for the `Reminder` type (it may only have one for `RecurringReminder` — check first).

**Step 4: Verify compilation**

Run: `cd bot && npx tsc --noEmit`
Expected: No type errors.

**Step 5: Commit**

```bash
git add bot/src/types.ts bot/src/recurringReminderExecutor.ts bot/tests/reminderScheduler.test.ts bot/tests/reminderScheduler.recurring.test.ts
git commit -m "feat: add ReminderMode type and PromptExecution interface"
```

---

### Task 2: Database migration v6

**Files:**
- Modify: `bot/src/db.ts`
- Test: `bot/tests/db.test.ts`

**Step 1: Write the failing test**

Add a test to `bot/tests/db.test.ts` for the v6 migration. Follow the existing pattern (see tests for v2-v5). The test should verify the `reminders` table has a `mode` column with default `'simple'`:

```typescript
describe('v6 migration - reminder mode column', () => {
  it('adds mode column with default simple', () => {
    const cols = db.conn.db.pragma('table_info(reminders)') as Array<{ name: string; dflt_value: string | null }>;
    const modeCol = cols.find(c => c.name === 'mode');
    expect(modeCol).toBeDefined();
    expect(modeCol!.dflt_value).toBe("'simple'");
  });
});
```

Note: `db` here is whatever test database fixture the existing tests use — follow the same pattern.

**Step 2: Run test to verify it fails**

Run: `cd bot && npx vitest run tests/db.test.ts`
Expected: FAIL — `mode` column does not exist yet.

**Step 3: Implement the migration**

In `bot/src/db.ts`:

1. Update `initTables()` — add `mode TEXT NOT NULL DEFAULT 'simple'` to the `CREATE TABLE reminders` statement (for fresh databases).

2. Add `migrateToV6()`:

```typescript
private migrateToV6(): void {
  const cols = this.db.pragma('table_info(reminders)') as Array<{ name: string }>;
  if (!cols.some(c => c.name === 'mode')) {
    this.db.exec("ALTER TABLE reminders ADD COLUMN mode TEXT NOT NULL DEFAULT 'simple'");
  }
}
```

3. Add to `runMigrations()` after the v5 check:

```typescript
if (currentVersion < 6) { this.migrateToV6(); this.setSchemaVersion(6); }
```

**Step 4: Run test to verify it passes**

Run: `cd bot && npx vitest run tests/db.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add bot/src/db.ts bot/tests/db.test.ts
git commit -m "feat: add v6 migration for reminder mode column"
```

---

### Task 3: Update ReminderStore to handle mode

**Files:**
- Modify: `bot/src/stores/reminderStore.ts`
- Modify: `bot/src/storage.ts` (facade)
- Test: `bot/tests/stores/reminderStore.test.ts`

**Step 1: Write the failing tests**

Add tests to `bot/tests/stores/reminderStore.test.ts`. Note: `getDueByGroup` takes 3 args: `(groupId, now, limit)`.

```typescript
describe('reminder mode', () => {
  it('creates reminder with default simple mode', () => {
    const id = store.create('group1', 'user1', 'test', futureTime);
    const reminders = store.getDueByGroup('group1', futureTime + 1000, 50);
    expect(reminders.find(r => r.id === id)?.mode).toBe('simple');
  });

  it('creates reminder with explicit prompt mode', () => {
    const id = store.create('group1', 'user1', 'check status', futureTime, 'prompt');
    const reminders = store.getDueByGroup('group1', futureTime + 1000, 50);
    expect(reminders.find(r => r.id === id)?.mode).toBe('prompt');
  });

  it('creates reminder with explicit simple mode', () => {
    const id = store.create('group1', 'user1', 'test', futureTime, 'simple');
    const reminders = store.getDueByGroup('group1', futureTime + 1000, 50);
    expect(reminders.find(r => r.id === id)?.mode).toBe('simple');
  });
});
```

Use whatever `futureTime` variable or constant the existing tests use. Check the test file to match the pattern.

**Step 2: Run tests to verify they fail**

Run: `cd bot && npx vitest run tests/stores/reminderStore.test.ts`
Expected: FAIL — `create()` doesn't accept `mode`.

**Step 3: Implement the changes**

In `bot/src/stores/reminderStore.ts`:

1. Import `ReminderMode` from `../types`.

2. Update the `insert` prepared statement (line 37-39) to include `mode`:

```sql
INSERT INTO reminders (groupId, requester, reminderText, dueAt, status, retryCount, createdAt, mode)
VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)
```

3. Update `create()` method signature (line 82) to accept optional mode:

```typescript
create(groupId: string, requester: string, reminderText: string, dueAt: number, mode: ReminderMode = 'simple'): number {
```

4. Update the `this.stmts.insert.run(...)` call (line 92) to pass `mode` as the last argument:

```typescript
const result = this.stmts.insert.run(groupId, requester, reminderText, dueAt, Date.now(), mode);
```

Note: `mapReminderRow` does NOT need changes. The spread `{ ...row, status: row.status as ReminderStatus }` already copies all fields including `mode`. The `NOT NULL DEFAULT 'simple'` constraint ensures the column always has a value.

**Step 4: Update `Storage` facade**

In `bot/src/storage.ts`, update `createReminder` (line 67) to pass through the optional mode:

```typescript
createReminder(groupId: string, requester: string, reminderText: string, dueAt: number, mode?: ReminderMode): number {
  return this.reminders.create(groupId, requester, reminderText, dueAt, mode);
}
```

Add `ReminderMode` to the import from `./types` on line 9.

**Step 5: Run tests to verify they pass**

Run: `cd bot && npx vitest run tests/stores/reminderStore.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add bot/src/stores/reminderStore.ts bot/src/storage.ts bot/tests/stores/reminderStore.test.ts
git commit -m "feat: update ReminderStore and Storage facade to accept mode"
```

---

### Task 4: Update ReminderScheduler to handle prompt mode

**Files:**
- Modify: `bot/src/reminderScheduler.ts`
- Test: `bot/tests/reminderScheduler.test.ts`

**Important context:** The `ReminderScheduler` constructor (line 15-20) already has `recurringExecutor` as its 4th parameter:

```typescript
constructor(
  private reminderStore: ReminderStore,
  private signalClient: SignalClient,
  private recurringStore?: RecurringReminderStore,
  private recurringExecutor?: RecurringReminderExecutor,
)
```

**No constructor change is needed.** The executor is already available as `this.recurringExecutor`.

**Step 1: Write the failing tests**

Add tests to `bot/tests/reminderScheduler.test.ts`. The existing tests create the scheduler with 2 args: `new ReminderScheduler(mockStore as any, mockSignalClient as any)`. For prompt mode tests, create the scheduler with all 4 args so the executor is available.

```typescript
describe('prompt mode reminders', () => {
  let mockExecutor: { execute: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockExecutor = { execute: vi.fn().mockResolvedValue(undefined) };
  });

  it('sends simple mode reminders as text messages (existing behavior)', async () => {
    const reminder = makeReminder({ mode: 'simple' });
    mockStore.getGroupsWithDueReminders.mockReturnValue(['group1']);
    mockStore.getDueByGroup.mockReturnValue([reminder]);
    const scheduler = new ReminderScheduler(
      mockStore as any, mockSignalClient as any, undefined, mockExecutor as any
    );
    await scheduler.processDueReminders();
    expect(mockSignalClient.sendMessage).toHaveBeenCalled();
    expect(mockExecutor.execute).not.toHaveBeenCalled();
  });

  it('spawns Claude session for prompt mode reminders', async () => {
    const reminder = makeReminder({ mode: 'prompt' });
    mockStore.getGroupsWithDueReminders.mockReturnValue(['group1']);
    mockStore.getDueByGroup.mockReturnValue([reminder]);
    const scheduler = new ReminderScheduler(
      mockStore as any, mockSignalClient as any, undefined, mockExecutor as any
    );
    await scheduler.processDueReminders();
    expect(mockExecutor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        groupId: reminder.groupId,
        promptText: reminder.reminderText,
        requester: reminder.requester,
      })
    );
    expect(mockSignalClient.sendMessage).not.toHaveBeenCalled();
  });

  it('marks prompt mode reminder as sent after successful execution', async () => {
    const reminder = makeReminder({ mode: 'prompt' });
    mockStore.getGroupsWithDueReminders.mockReturnValue(['group1']);
    mockStore.getDueByGroup.mockReturnValue([reminder]);
    const scheduler = new ReminderScheduler(
      mockStore as any, mockSignalClient as any, undefined, mockExecutor as any
    );
    await scheduler.processDueReminders();
    expect(mockStore.markSent).toHaveBeenCalledWith(reminder.id);
  });

  it('does not crash when executor throws for prompt mode (retry on next cycle)', async () => {
    const reminder = makeReminder({ mode: 'prompt' });
    mockStore.getGroupsWithDueReminders.mockReturnValue(['group1']);
    mockStore.getDueByGroup.mockReturnValue([reminder]);
    mockExecutor.execute.mockRejectedValue(new Error('Claude timeout'));
    const scheduler = new ReminderScheduler(
      mockStore as any, mockSignalClient as any, undefined, mockExecutor as any
    );
    // Should not throw — error is caught and logged
    const result = await scheduler.processDueReminders();
    expect(result).toBe(0); // Not sent successfully
  });
});
```

Adapt the test setup to match the existing patterns in the file (mock creation, makeReminder defaults, etc.).

**Step 2: Run tests to verify they fail**

Run: `cd bot && npx vitest run tests/reminderScheduler.test.ts`
Expected: FAIL — no branching on mode in `processReminder()`.

**Step 3: Implement the changes**

In `bot/src/reminderScheduler.ts`:

1. Add `PromptExecution` to the import from `./types` (line 6).

2. In `processReminder()` (line 100-141), replace the send logic (lines 130-140) with a branch on mode. After the `recordAttempt` call (line 128), replace lines 130-140 with:

```typescript
    try {
      if (reminder.mode === 'prompt') {
        if (!this.recurringExecutor) {
          throw new Error('Prompt mode reminder but no executor configured');
        }
        const execution: PromptExecution = {
          id: reminder.id,
          groupId: reminder.groupId,
          requester: reminder.requester,
          promptText: reminder.reminderText,
        };
        await this.recurringExecutor.execute(execution);
      } else {
        const messageText = this.formatReminderMessage(reminder, staleness);
        await this.signalClient.sendMessage(reminder.groupId, messageText);
      }
      this.reminderStore.markSent(reminder.id);
      return true;
    } catch (error) {
      logger.error(`Failed to ${reminder.mode === 'prompt' ? 'execute' : 'send'} reminder ${reminder.id}:`, error);
      return false;
    }
```

Key design decisions:
- **No timezone on `PromptExecution`**: timezone is left undefined, so the executor falls back to `this.appConfig.timezone` (see Task 1).
- **`formatReminderMessage` is only used for simple mode**: prompt mode passes `reminderText` directly as the prompt.
- **Unified `markSent` path**: both modes mark sent on success, same as before.
- **Error handling**: same pattern as current — don't mark failed, let retry happen via existing `retryCount` logic.
- **Blocking risk acknowledged**: prompt mode may block the scheduler for up to 5 minutes (the executor's timeout). This is acceptable for v1 — the scheduler already blocks on each reminder sequentially.

**Step 4: Run tests to verify they pass**

Run: `cd bot && npx vitest run tests/reminderScheduler.test.ts`
Expected: PASS

**Step 5: Run full test suite**

Run: `cd bot && npx vitest run`
Expected: All tests pass.

**Step 6: Commit**

```bash
git add bot/src/reminderScheduler.ts bot/tests/reminderScheduler.test.ts
git commit -m "feat: ReminderScheduler branches on mode, spawns Claude for prompt reminders"
```

---

### Task 5: Update MCP tools (set_reminder + list_reminders)

**Files:**
- Modify: `bot/src/mcp/servers/reminders.ts`
- Test: `bot/tests/reminderMcpServer.test.ts`

**Step 1: Write the failing tests**

Add tests to the existing `set_reminder` test block in `bot/tests/reminderMcpServer.test.ts`:

```typescript
it('creates a prompt mode reminder when mode is specified', async () => {
  // Call set_reminder with { reminderText: '...', dueAt: futureTs, mode: 'prompt' }
  // Assert store.create was called with 'prompt' as the 5th arg
});

it('defaults to simple mode when mode is not specified', async () => {
  // Call set_reminder with { reminderText: '...', dueAt: futureTs } (no mode)
  // Assert store.create was called without a mode arg (relying on default)
});

it('rejects invalid mode values', async () => {
  // Call set_reminder with { reminderText: '...', dueAt: futureTs, mode: 'invalid' }
  // Assert error response containing 'Invalid mode'
});
```

Follow the existing test patterns for how the MCP server is invoked in tests.

**Step 2: Run tests to verify they fail**

Run: `cd bot && npx vitest run tests/reminderMcpServer.test.ts`
Expected: FAIL — tool doesn't accept or validate mode parameter.

**Step 3: Implement the changes**

In `bot/src/mcp/servers/reminders.ts`:

1. Update the `set_reminder` tool's `inputSchema.properties` (around line 19-24) to add `mode`:

```typescript
mode: {
  type: 'string',
  enum: ['simple', 'prompt'],
  description:
    'Reminder mode: "simple" (default) sends the text as a message. "prompt" spawns a full Claude session with MCP tools to process the text as an instruction (use for tasks that need reasoning or tool access, e.g. "check the weather and report").',
},
```

Do NOT add `mode` to the `required` array.

2. Update the `set_reminder` handler (line 105-122) to extract and validate `mode`, then pass it to `store.create()`:

After the existing `dueAt` validation, add:

```typescript
const mode = args.mode as string | undefined;
if (mode !== undefined && mode !== 'simple' && mode !== 'prompt') {
  return error(`Invalid mode: "${mode}". Must be "simple" or "prompt".`);
}
```

Update the `store.create` call (line 118) to pass mode:

```typescript
const id = store.create(groupId, sender, reminderText.value, dueAt.value, (mode as ReminderMode) ?? 'simple');
```

Import `ReminderMode` from `../../types`.

3. Update the `list_reminders` handler (lines 133-137) to show mode for prompt reminders:

```typescript
const lines = reminders.map(r => {
  const due = new Date(r.dueAt).toLocaleString('en-AU', { timeZone: tz });
  const modeLabel = r.mode === 'prompt' ? ' [prompt]' : '';
  return `#${r.id} | Due: ${due}${modeLabel} | "${r.reminderText}" (set by ${r.requester})`;
});
```

4. Update the `set_reminder` response to include mode info when it's `prompt`:

```typescript
const modeInfo = (mode === 'prompt') ? ' (prompt mode — will spawn a Claude session)' : '';
return ok(`Reminder #${id} set for ${formatted}: "${reminderText.value}"${modeInfo}`);
```

**Step 4: Run tests to verify they pass**

Run: `cd bot && npx vitest run tests/reminderMcpServer.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add bot/src/mcp/servers/reminders.ts bot/tests/reminderMcpServer.test.ts
git commit -m "feat: set_reminder MCP tool accepts optional mode parameter, list shows mode"
```

---

### Task 6: Final validation

**Files:**
- No new files — validation only

**Step 1: Run full test suite**

Run: `cd bot && npx vitest run`
Expected: All tests pass.

**Step 2: Run lint and format check**

Run: `cd bot && npm run check`
Expected: No errors.

**Step 3: Fix any issues found**

If lint/test failures, fix them and re-run.

**Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix: lint and test fixes for prompt mode feature"
```

---

## Revisions

Changes made after devil's advocate review (`plan-review.md`):

### Addressed:
1. **Type incompatibility (Critical):** Extracted `PromptExecution` interface in `types.ts`. Changed `RecurringReminderExecutor.execute()` to accept `PromptExecution` instead of `RecurringReminder`. This is clean and minimal — `RecurringReminder` already satisfies `PromptExecution`.
2. **Constructor signature (High):** Removed the incorrect constructor change. The plan now correctly notes that `recurringExecutor` is already the 4th param and no constructor change is needed.
3. **Timezone (High):** The executor uses `reminder.timezone ?? this.appConfig.timezone` as fallback. One-off prompt reminders don't pass timezone, so they inherit the app-level timezone.
4. **getDueByGroup arity (Medium):** Fixed all test examples to include the 3rd `limit` argument.
5. **makeReminder helpers (Medium):** Added explicit step in Task 1 to update `makeReminder()` in both `reminderScheduler.test.ts` and `reminderScheduler.recurring.test.ts`.
6. **list_reminders display (Medium):** Added to Task 5 — shows `[prompt]` label for non-simple reminders.
7. **Storage facade (Low):** Added to Task 3 — `Storage.createReminder()` now passes through the optional mode.
8. **Tool description (Low):** Improved `set_reminder` mode description to explain when to use each mode.

### Dismissed:
- **mapReminderRow change (Concern 4):** Review correctly noted the spread handles it. Removed the unnecessary `?? 'simple'` fallback from the plan.
- **Integration test (Concern 8):** The unit tests cover the branching logic and type mapping adequately. Full integration is tested via the dark factory integration test stage (Stage 6).
- **Scheduler blocking (Concern 9):** Acknowledged in the plan as acceptable for v1. The scheduler already processes sequentially. A future optimization could use `Promise.race` with a separate queue, but that's YAGNI for now.
- **recordAttempt semantics (Concern 10):** Accepted as-is per review's recommendation.
- **YAGNI on migration (Concern 12):** Migration is justified per review.
- **v6 collision risk (Concern 13):** Master is at v5 with no pending v6 in other branches.
