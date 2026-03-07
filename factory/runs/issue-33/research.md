# Research: Issue #33 — Recurring Reminders

## Codebase Analysis

### Key Patterns to Follow
- **Store pattern**: Constructor takes `DatabaseConnection`, prepared statements in `stmts` object, methods use `conn.runOp()` and `conn.ensureOpen()`, row mapping functions for type safety
- **Migration pattern**: `migrateToVN()` private methods, `if (currentVersion < N)` guards, `setSchemaVersion(N)` after migration. Currently at V4.
- **MCP server pattern**: `TOOLS` array + `handlers` map + `onInit()`/`onClose()`. Tools added to existing server definition.
- **Storage facade**: Constructor initializes all stores, exposes via `readonly` fields + delegation methods
- **spawnPromise**: Private function in `claudeClient.ts` (lines 25-67). Needs extraction or duplication for recurring executor.

### Integration Points
1. `db.ts` — V5 migration for `recurring_reminders` table
2. `types.ts` — New `RecurringReminder` interface
3. `stores/recurringReminderStore.ts` — New store following existing patterns
4. `mcp/servers/reminders.ts` — 3 new tools added to existing server (same env vars)
5. `reminderScheduler.ts` — Add optional recurring deps, new `processRecurringReminders()` method
6. `recurringReminderExecutor.ts` — Spawns Claude CLI with full MCP config
7. `storage.ts` — Add `recurringReminders` store to facade
8. `index.ts` — Wire executor + store, call in polling loop

### Risk: spawnPromise Extraction
`spawnPromise` is private in `claudeClient.ts`. The executor needs it. Options:
- Export it from `claudeClient.ts` (simplest)
- Extract to `utils/spawnProcess.ts` (cleaner)
Decision: Export from claudeClient.ts to minimize file churn.

## Croner Library

### API Summary
```typescript
import { Cron } from 'croner';

// Create with timezone
const cron = new Cron('0 8 * * *', { timezone: 'Australia/Sydney' });

// Get next occurrence
const next: Date = cron.nextDate();            // from now
const after: Date = cron.nextDate(someDate);   // after specific date

// Convert to Unix ms for storage
const unixMs = next.getTime();

// Validation: throws on invalid expressions
try { new Cron('invalid'); } catch (e) { /* invalid */ }
```

### Key Points
- Zero dependencies, native TypeScript
- Timezone-aware via IANA timezone strings
- `nextDate()` accepts optional start date
- Throws Error on invalid cron expressions
- Standard 5-field cron format (minute hour day month weekday)

## Test Patterns

### Store Tests (reminderStore.test.ts)
- `createTestDb()` from `bot/tests/helpers/testDb.ts` for in-memory DB
- `vi.spyOn()` on `Date.now()` for time control
- Factory functions for test data
- Assert return values AND database side effects

### Scheduler Tests (reminderScheduler.test.ts)
- Mock stores and SignalClient with `vi.fn()`
- Test per-group isolation, claim-then-send, exponential backoff
- Test failure resilience (continue after individual failure)

### MCP Server Tests (reminderMcpServer.test.ts)
- `spawnMcpServer()` + `sendAndReceive()` from `bot/tests/helpers/mcpTestHelpers.ts`
- Test tool listing, success cases, error cases
- Cleanup with `proc.kill()`

## Prior Art
- No cron or recurring reminder work in git history
- No conflicting open issues
- Approved plan at `/home/zknowles/.claude/plans/synthetic-finding-donut.md` covers full design
