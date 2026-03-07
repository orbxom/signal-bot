# Devil's Advocate Review: Issue #41 -- One-off Reminders Prompt Mode

## Summary Verdict

The plan is generally sound and well-structured. The feature scope is modest and the approach of reusing `RecurringReminderExecutor` is the right call. However, there are several inaccuracies in the plan's assumptions about existing code, a significant type compatibility problem that is acknowledged but not solved, and some missing edge cases. Below is a detailed critique.

---

## Concern 1: Type Incompatibility Between `Reminder` and `RecurringReminder` (Critical)

**What:** The plan says to call `this.executor.execute(reminder)` where `executor` is `RecurringReminderExecutor` and `reminder` is of type `Reminder`. But `execute()` accepts `RecurringReminder`, not `Reminder`. These types are structurally incompatible:

- `Reminder` has `reminderText: string`, while `RecurringReminder` has `promptText: string`.
- `RecurringReminder` has `timezone: string`, `cronExpression: string`, `consecutiveFailures: number`, `nextDueAt: number`, `lastFiredAt`, `lastInFlightAt`, `updatedAt` -- none of which exist on `Reminder`.
- `Reminder` has `dueAt`, `retryCount`, `sentAt`, `lastAttemptAt`, `failureReason`, `mode` -- none of which exist on `RecurringReminder`.

The plan's Task 4, Step 3 shows this pseudo-code:

```typescript
await this.executor.execute({
  groupId: reminder.groupId,
  promptText: reminder.reminderText,
  // Map Reminder fields to what the executor expects
});
```

That comment "Map Reminder fields to what the executor expects" is doing a lot of handwaving. The executor's `execute()` method reads `reminder.groupId`, `reminder.requester`, `reminder.timezone`, and `reminder.promptText`. It also logs `reminder.id`. So you need to fabricate a `RecurringReminder` object or at least a compatible subset.

**Why it matters:** This is the central architectural question of the feature. If you get this mapping wrong, the executor will read `undefined` for `timezone` (used in the system prompt) and `promptText`, which would be a runtime crash or produce nonsensical output.

**Recommendation:** The plan should explicitly define the adapter mapping. There are two clean options:

1. **Extract an interface** (e.g., `PromptExecution`) that both `RecurringReminder` and the adapter satisfy, containing just `{ id: number; groupId: string; requester: string; promptText: string; timezone: string }`. Refactor `RecurringReminderExecutor.execute()` to accept this interface instead of the concrete `RecurringReminder` type. This is the cleanest approach.

2. **Build a synthetic `RecurringReminder`** inline with dummy values for unused fields. This is ugly but functional. The risk is that future changes to `execute()` might start reading fields you set to dummy values.

Option 1 is clearly better and the plan should prescribe it explicitly.

---

## Concern 2: `ReminderScheduler` Constructor Signature is Wrong in the Plan (Factual Error)

**What:** The plan (Task 4, Step 3) shows the constructor as:

```typescript
constructor(
  private reminderStore: ReminderStore,
  private recurringReminderStore: RecurringReminderStore,
  private signalClient: SignalClient,
  private executor?: RecurringReminderExecutor,
)
```

The actual constructor signature in `bot/src/reminderScheduler.ts` (line 15-20) is:

```typescript
constructor(
  private reminderStore: ReminderStore,
  private signalClient: SignalClient,
  private recurringStore?: RecurringReminderStore,
  private recurringExecutor?: RecurringReminderExecutor,
)
```

Note the differences: (a) `signalClient` is the second parameter, not third; (b) the recurring store is named `recurringStore`, not `recurringReminderStore`; (c) the executor is named `recurringExecutor`, not `executor`.

**Why it matters:** If an implementer follows the plan literally, they will reorder the constructor parameters and break every existing call site, including the composition root in `index.ts` and every test file. The existing test creates the scheduler as `new ReminderScheduler(mockStore as any, mockSignalClient as any)` (2 positional args), which depends on `signalClient` being the second parameter.

**Recommendation:** The plan should not propose changing the constructor parameter order. Since `recurringExecutor` is already injected, the executor is already available for prompt-mode use. No constructor change is needed at all -- just use `this.recurringExecutor` in the `processReminder()` method's prompt-mode branch.

---

## Concern 3: The Executor Needs `timezone` But `Reminder` Doesn't Have One (Design Gap)

**What:** `RecurringReminderExecutor.execute()` uses `reminder.timezone` in the system prompt:

```typescript
`Timezone: ${reminder.timezone}`,
```

The `Reminder` type has no `timezone` field. Where does it come from for one-off prompt reminders?

**Why it matters:** Without a timezone, the Claude session spawned for a prompt-mode reminder won't know the local time. This matters because many prompt-mode use cases will involve time-sensitive queries (e.g., "check today's weather", "summarize today's messages").

**Recommendation:** The simplest approach: read the timezone from `AppConfig` (which `RecurringReminderExecutor` already stores as `this.appConfig.timezone`). The executor already has access to this. If you extract an interface per Concern 1, you could either:
- Include `timezone` as a required field and populate it from the app config when constructing the adapter object, or
- Have the executor fall back to `this.appConfig.timezone` when `reminder.timezone` is not provided.

Either way, this needs to be explicitly addressed in the plan.

---

## Concern 4: `ReminderRow` Type Will Silently Drop `mode` from `SELECT *` Results (Subtle Bug Risk)

**What:** The `ReminderRow` type is defined as:

```typescript
type ReminderRow = Omit<Reminder, 'status'> & { status: string };
```

And `mapReminderRow` is:

```typescript
function mapReminderRow(row: ReminderRow): Reminder {
  return { ...row, status: row.status as ReminderStatus };
}
```

Since all queries use `SELECT *`, the `mode` column WILL be present in the raw row data from SQLite. And because `ReminderRow` is defined relative to `Reminder`, once `mode` is added to the `Reminder` interface, `ReminderRow` will automatically include it. The spread in `mapReminderRow` will pass it through.

**Why it matters:** This actually works correctly by accident -- the plan's suggestion to add `mode: row.mode ?? 'simple'` to `mapReminderRow` is unnecessary. The spread already copies all fields. The only thing `mapReminderRow` actively does is cast `status`. Since `mode` on `ReminderRow` would already be typed as `ReminderMode` (inherited from `Reminder`), the spread handles it.

The plan's suggestion to add a `?? 'simple'` fallback is defensive but technically unnecessary given the `NOT NULL DEFAULT 'simple'` constraint on the column. However, it is not harmful and provides a belt-and-suspenders safety net. Acceptable either way.

**Recommendation:** The plan should note that no change to `mapReminderRow` is strictly required. The existing spread pattern handles new fields automatically as long as `Reminder` (and by extension `ReminderRow`) includes the field. If adding the fallback, a comment explaining why would be helpful.

---

## Concern 5: Plan's Test Code for Task 3 Uses Wrong `getDueByGroup` Signature (Factual Error)

**What:** The plan's Task 3 test code shows:

```typescript
const reminders = store.getDueByGroup('group1', futureTime + 1000);
```

The actual `getDueByGroup` signature requires 3 arguments: `(groupId: string, now: number, limit: number)`. The `limit` parameter is not optional.

**Why it matters:** The test code as written in the plan won't compile. This is a minor error but indicates the plan was written from memory rather than verified against the actual signatures.

**Recommendation:** Fix the test examples to include the third argument: `store.getDueByGroup('group1', futureTime + 1000, 50)`.

---

## Concern 6: Existing Tests Will Fail Due to Missing `mode` in `makeReminder` (Breaking Change)

**What:** Once `mode: ReminderMode` is added to the `Reminder` interface, every place that constructs a `Reminder` object will need to include `mode`. The test helper `makeReminder()` in both `reminderScheduler.test.ts` and `reminderScheduler.recurring.test.ts` constructs `Reminder` objects without `mode`:

```typescript
function makeReminder(overrides: Partial<Reminder> = {}): Reminder {
  return {
    id: 1,
    groupId: 'group1',
    ...
    failureReason: null,
    ...overrides,
  };
}
```

After adding `mode` to the `Reminder` interface, TypeScript will error on this function because the returned object literal doesn't include `mode`.

**Why it matters:** The plan mentions this will happen ("existing tests, which use simple mode by default") but doesn't explicitly call out that `makeReminder` helpers in BOTH test files need updating. The plan only discusses tests in the context of new tests to add. The implementer needs to update `makeReminder` in at least two files.

**Recommendation:** Task 1 or Task 4 should explicitly state: "Update the `makeReminder()` helper in `bot/tests/reminderScheduler.test.ts` and `bot/tests/reminderScheduler.recurring.test.ts` to include `mode: 'simple'` as a default value."

---

## Concern 7: `list_reminders` MCP Tool Should Display Mode (Missing from Plan)

**What:** The `list_reminders` handler in `reminders.ts` formats output as:

```typescript
`#${r.id} | Due: ${due} | "${r.reminderText}" (set by ${r.requester})`
```

After adding `mode`, users who set prompt-mode reminders have no way to see which mode a reminder is in when listing them.

**Why it matters:** If a user sets a prompt-mode reminder, then lists reminders, they can't distinguish prompt reminders from simple ones. This is a usability gap.

**Recommendation:** Update the `list_reminders` handler to show the mode when it's not `'simple'`, e.g.:

```typescript
const modeLabel = r.mode === 'prompt' ? ' [prompt]' : '';
return `#${r.id} | Due: ${due}${modeLabel} | "${r.reminderText}" (set by ${r.requester})`;
```

This is a small addition that should be included in Task 5.

---

## Concern 8: No Integration Test for the Full Prompt-Mode Flow (Test Gap)

**What:** The plan's test strategy tests each layer in isolation:
- Store tests verify mode is persisted
- Scheduler tests mock the executor and verify branching
- MCP tests verify the tool accepts the parameter

But there's no test that verifies the complete flow: MCP tool sets a prompt-mode reminder -> scheduler picks it up -> executor is called with the correct fields.

**Why it matters:** The type adapter between `Reminder` and the executor's expected input (Concern 1) is the riskiest part of this change. Without an integration test, a field mapping bug could ship undetected. The existing MCP server test (`reminderMcpServer.test.ts`) spawns a real child process and uses a real SQLite DB -- this pattern could be extended.

**Recommendation:** Add at least one integration-style test (perhaps in the scheduler test file) that uses a real `ReminderStore` with a real SQLite DB, creates a prompt-mode reminder via the store, then verifies that when `processDueReminders()` runs, the executor receives the correctly mapped fields.

---

## Concern 9: Error Handling for Prompt-Mode Failures Needs Clarity (Edge Case)

**What:** The plan's Task 4, Step 3 shows:

```typescript
if (!this.executor) {
  throw new Error('Prompt mode reminder but no executor configured');
}
```

In the current `processReminder()` method, exceptions are caught by the `processGroupReminders()` loop:

```typescript
try {
  const result = await this.processReminder(reminder, now);
  if (result) sentCount++;
} catch (error) {
  logger.error(`Unexpected error processing reminder ${reminder.id}:`, error);
}
```

So throwing an error won't crash the bot, but the reminder stays in `pending` status because `recordAttempt()` was already called (incrementing `retryCount`). This means it will retry up to MAX_RETRIES (3) times before being marked failed.

But wait -- `recordAttempt()` happens BEFORE the mode branch. If the executor throws, the reminder will retry. `RecurringReminderExecutor.execute()` can throw on Claude CLI timeout (5 minute timeout), output parsing failure, or Signal send failure. Each failure will consume a retry.

With a 5-minute timeout and 3 retries with exponential backoff (60s, 120s, 240s), a prompt-mode reminder that consistently fails will take approximately 5+1+5+2+5+4 = 22 minutes before being marked as permanently failed. Meanwhile, the scheduler's 30-second polling loop will be blocked during each 5-minute Claude execution.

**Why it matters:** A stuck prompt-mode reminder could block the entire reminder scheduler for 5 minutes per attempt. The scheduler processes reminders sequentially within a group, and the polling loop is single-threaded.

**Recommendation:** Consider whether prompt-mode reminders should have a shorter timeout than the 5-minute default, or whether the scheduler should process prompt-mode reminders with a separate concurrency mechanism. At minimum, the plan should acknowledge the blocking risk and decide whether it's acceptable for an initial implementation.

---

## Concern 10: `recordAttempt` Placement for Prompt Mode (Design Question)

**What:** The current `processReminder()` calls `recordAttempt()` before sending, as a claim-then-send pattern. For simple mode, this makes sense -- if the bot crashes between recordAttempt and markSent, the retryCount prevents infinite retries.

For prompt mode, `recordAttempt()` is called before spawning a 5-minute Claude session. If the Claude session succeeds and sends via MCP, there's no crash risk. But the attempt counter is incremented regardless.

**Why it matters:** The claim-then-send pattern is less relevant for prompt mode since the executor already handles its own error recovery. A prompt-mode reminder that succeeds on the first try will still have `retryCount: 1` and `lastAttemptAt` set, which is a minor data inconsistency but not harmful.

**Recommendation:** This is acceptable for a first implementation. Document it as a known quirk.

---

## Concern 11: Missing Validation -- What If `reminderText` Is Not a Good Prompt? (UX Risk)

**What:** When `mode='prompt'`, the `reminderText` is used as the prompt for a Claude session. The plan doesn't add any validation specific to prompt mode.

**Why it matters:** A user might set a prompt-mode reminder with text like "dentist appointment" -- which would make sense as a simple text reminder but is a poor prompt for a Claude session. The Claude session would likely just send "dentist appointment" back as a message, wasting a full Claude invocation.

**Recommendation:** This is arguably a documentation/UX concern rather than a code concern. The `set_reminder` tool's description should be updated to explain when to use prompt mode and what makes a good prompt. For example:

```
'Reminder mode: "simple" (default) sends the text as a message, "prompt" spawns a Claude session that processes the text as an instruction (e.g., "Check the weather forecast and summarize it"). Use "prompt" when the reminder should DO something, use "simple" when it should just SAY something.'
```

---

## Concern 12: YAGNI Check -- Is the Migration Necessary?

**What:** The plan adds a database column and migration. Is there a simpler way to achieve the same result?

**Why it matters:** A migration is a permanent schema change. If the feature is later removed or redesigned, the column remains.

**Recommendation:** The migration is justified. The alternative would be encoding mode in the `reminderText` itself (e.g., a prefix convention), which would be fragile and ugly. A proper column is the right approach for structured data. The migration is also trivially simple (one ALTER TABLE). This concern is raised for completeness but I agree with the plan's approach.

---

## Concern 13: The Plan Says "v6 Migration" but the Research Says "Up to v5 Currently" -- Verify No Pending v6 Exists

**What:** The plan assumes the next migration is v6. The current schema version is 5.

**Why it matters:** If another branch or pending PR has already claimed v6, there will be a conflict.

**Recommendation:** Before implementation, verify no other in-progress work has added a v6 migration. The git status shows the master branch is at schema v5 (confirmed by reading `db.ts`), so this should be fine for now. Just a reminder to check before merging.

---

## Concern 14: `Storage` Facade's `createReminder` Method Doesn't Pass `mode` (Missed File)

**What:** The `Storage` class in `bot/src/storage.ts` has a `createReminder` method:

```typescript
createReminder(groupId: string, requester: string, reminderText: string, dueAt: number): number {
  return this.reminders.create(groupId, requester, reminderText, dueAt);
}
```

This facade method doesn't accept or pass a `mode` parameter. While the MCP server creates reminders directly via the `ReminderStore` (not through the `Storage` facade), the facade is still a public API that should be updated for consistency.

**Why it matters:** If any other code path uses `Storage.createReminder()` to create reminders, it won't be able to create prompt-mode reminders. Even if nothing currently uses it for prompt mode, the inconsistency is a maintenance burden.

**Recommendation:** Either update `Storage.createReminder()` to accept an optional `mode` parameter, or note in the plan that this is intentionally left as-is because the MCP server bypasses the facade. The plan's "Files to Modify" list in the research does not mention `storage.ts`.

---

## Summary of Recommendations

| # | Severity | Issue | Action |
|---|----------|-------|--------|
| 1 | **Critical** | `Reminder` vs `RecurringReminder` type mismatch | Extract a shared `PromptExecution` interface |
| 2 | **High** | Constructor signature wrong in plan | Don't change the constructor; use existing `this.recurringExecutor` |
| 3 | **High** | `timezone` missing from `Reminder` type | Source it from `AppConfig` via the executor |
| 4 | **Low** | `mapReminderRow` change unnecessary | Note that spread handles it; fallback is optional |
| 5 | **Medium** | `getDueByGroup` test code wrong arity | Fix test examples to include `limit` argument |
| 6 | **Medium** | `makeReminder` helpers will break | Explicitly update both test files |
| 7 | **Medium** | `list_reminders` should show mode | Add mode label to list output |
| 8 | **Medium** | No integration test | Add one end-to-end-ish test |
| 9 | **Medium** | Prompt mode blocks scheduler for up to 5 min | Acknowledge and document the risk |
| 10 | **Low** | `recordAttempt` semantics for prompt mode | Accept as-is, document |
| 11 | **Low** | No prompt-quality validation | Improve tool description |
| 12 | **None** | YAGNI on migration | Migration is justified |
| 13 | **Low** | v6 migration collision risk | Verify before implementation |
| 14 | **Low** | `Storage` facade not updated | Update or document omission |

The plan is implementable with the fixes above. Concerns 1, 2, and 3 are the ones most likely to cause real bugs if not addressed.
