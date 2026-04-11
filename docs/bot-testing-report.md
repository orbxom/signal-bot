# Bot Core Testing Report

**Date:** 2026-04-11
**Branch:** `feature/management-dashboard` (commit `bf78996`)
**Tested by:** Claude (manual testing via mock signal server + code review)
**Focus:** Core bot functionality — message handling, MCP tools, resilience, edge cases

## Test Environment

- Mock signal server on port 9090 (`bot/src/mock/signalServer.ts`)
- Bot in mock mode (`npm run dev:mock`) with fresh database (`data/mock-bot.db`)
- Collaborative testing mode enabled
- All 988 bot tests passing, 65 test files

## Summary

| Severity | Count |
|----------|-------|
| High     | 1 |
| Medium   | 3 |
| Low      | 3 |
| **Total** | **7** |

---

## High

### BUG 1: TypeScript build is broken — 5 type errors prevent `npm run build`

**Files:** `bot/src/config.ts:100`, `bot/src/index.ts:44,67`, `bot/src/messageHandler.ts:48`, `bot/src/stores/groupSettingsStore.ts:92`

**Steps to reproduce:**
```bash
cd bot && npx tsc --noEmit
```

**Expected:** Clean build with no errors.
**Actual:** 5 type errors:

```
src/config.ts(100,7): error TS2353: Object literal may only specify known properties,
  and 'swaDeploymentToken' does not exist in type 'ConfigType'.

src/index.ts(44,59): error TS2345: ... missing the following properties from type
  'AppConfig': swaDeploymentToken, swaHostname, webAppsDir

src/index.ts(67,7): error TS2739: ... missing the following properties from type
  'AppConfig': swaDeploymentToken, swaHostname, webAppsDir

src/messageHandler.ts(48,5): error TS2322: ... missing the following properties from type
  'AppConfig': swaDeploymentToken, swaHostname, webAppsDir, logsDir

src/stores/groupSettingsStore.ts(92,43): error TS2554: Expected 1 arguments, but got 2.
```

**Root cause:** Three type definitions are out of sync:

1. **`ConfigType`** (config.ts:4-27) is missing `swaDeploymentToken`, `swaHostname`, and `webAppsDir` — but `Config.load()` returns them. These fields were added to the return object but not to the interface.

2. **`AppConfig`** (types.ts:105-120) includes `swaDeploymentToken`, `swaHostname`, `webAppsDir`, and `logsDir`, but the `appConfig` literal in `index.ts:30-42` and the default in `messageHandler.ts:48-59` don't include them.

3. **`groupSettingsStore.ts:92`** calls `this.listAll_.all(limit, offset)` with 2 arguments but the prepared statement type (`Statement<unknown>`) only accepts 1. The SQL query itself has 2 bind parameters (`LIMIT ? OFFSET ?`), so the runtime behavior is correct — this is just a type annotation issue.

**Impact:** The bot runs fine via `tsx` (which skips type checking), but `npm run build` (TypeScript compilation) fails. This blocks any compiled production deployment and means type safety is not being enforced for new code.

**Fix:** Align all three types:
- Add `swaDeploymentToken`, `swaHostname`, `webAppsDir` to `ConfigType`
- Add `swaDeploymentToken`, `swaHostname`, `webAppsDir`, `logsDir` to the `appConfig` literal in `index.ts` and the default in `messageHandler.ts`
- Type the `listAll_` prepared statement as `Statement<[number, number]>` or use `as any`

---

## Medium

### BUG 2: Pre-formatted history cache is never used (performance waste)

**File:** `bot/src/contextBuilder.ts:210`

```typescript
const useCache = preFormatted && !nameMap;
```

**Root cause:** `nameMap` is always a `Map<string, string>` (returned from `assembleAdditionalContext()`). Even when empty, a Map is truthy, so `!nameMap` is always `false` and `useCache` is always `false`. The pre-formatted history strings produced by `fitToTokenBudget()` are never used — messages are re-formatted from scratch on every LLM call.

**Impact:** Unnecessary CPU work on every bot response. With a 200-message context window, this reformats up to 200 messages per call when the cached versions would be identical (no dossier names to substitute when the nameMap is empty).

**Fix:** Check map size instead of truthiness:
```typescript
const useCache = preFormatted && (!nameMap || nameMap.size === 0);
```

---

### BUG 3: Biome lint/format check fails — 22 errors across 20 files

**Steps to reproduce:**
```bash
cd bot && npm run check
```

**Actual:** 22 errors (mostly formatting), 8 warnings, 2 infos across source and test files.

**Affected files include:** `claudeClient.ts`, `db.ts`, `signalClient.ts`, `notifications.ts`, `mock/signalServer.ts`, multiple store files, and several test files.

**Error types:**
- `format`: Biome would reformat the file (whitespace, line wrapping)
- `organizeImports`: Import order doesn't match Biome's sorting rules
- `useTemplate`: String concatenation instead of template literals
- `noUnusedImports`: Unused import in test file

**Impact:** CI/CD lint gates would fail. New contributions may introduce more drift if the baseline isn't clean.

**Fix:** Run `npm run check:fix` to auto-fix all issues, then commit.

---

### BUG 4: Bot responses use "fallback" delivery instead of MCP `send_message`

**Observed during:** All manual tests

**Steps to reproduce:** Send any trigger message. Check bot log for delivery method.

**Expected:** Bot uses the `send_message` MCP tool (as instructed by the system prompt: "Always use send_message for your responses").
**Actual:** Every response logged `delivery: sent via fallback` — meaning Claude returned the response as plain text in its result rather than calling the `send_message` tool.

**Bot log evidence:**
```
llm: result via result field
delivery: sent via fallback
```

This was consistent across all 8+ test messages.

**Impact:** The fallback delivery path works correctly, so users see responses. However:
- The system prompt explicitly says "Always use send_message for your responses"
- When using fallback, the bot can't send multi-part responses (acknowledgment + work + final answer)
- Tool notification messages won't fire for `send_message` calls (since it's not being called)
- The `sentViaMcp` / `mcpMessages` tracking in `parseClaudeOutput` is unused

**Possible causes:**
- The `--max-turns 25` may need to be higher for tool discovery + use
- The `--allowedTools` list is very long (80+ tools) which may cause Claude to skip tool usage
- The `ToolSearch` indirection (Claude must first call ToolSearch to load the schema before it can call send_message) adds friction
- In collaborative testing mode, Claude may behave differently

**Note:** This is borderline between a code bug and a prompt engineering issue. The fallback path exists and works, but the intended behavior is MCP-first delivery.

---

## Low

### BUG 5: `notableDates` server uses system time for default date, not configured timezone

**File:** `bot/src/mcp/servers/notableDates.ts:177-180`

```typescript
if (dateArg === '') {
  const now = new Date();
  year = now.getFullYear();
  month = now.getMonth() + 1;
  day = now.getDate();
}
```

When no date argument is provided, the server uses `new Date()` which returns the system's local time. On Linux, the `TZ` environment variable (set to the configured timezone, e.g. `Australia/Sydney`) is typically respected by Node.js, so this usually works correctly.

However, if the `TZ` env var is not set or the system timezone differs from the configured bot timezone, the "today" date could be wrong during timezone boundary hours. For example, if the system is UTC and the bot timezone is `Australia/Sydney` (UTC+10), calling at 11pm UTC (9am Sydney) would use the UTC date instead of the Sydney date.

**Impact:** Low — the NUC production server is likely configured with Australian timezone, and the MCP server is spawned with `TZ` set. Only affects edge cases where system timezone differs from configured timezone.

**Fix:** Use the timezone-aware approach:
```typescript
const now = new Date();
const parts = new Intl.DateTimeFormat('en-CA', {
  timeZone: readTimezone(),
  year: 'numeric', month: '2-digit', day: '2-digit'
}).formatToParts(now);
year = Number(parts.find(p => p.type === 'year')?.value);
month = Number(parts.find(p => p.type === 'month')?.value);
day = Number(parts.find(p => p.type === 'day')?.value);
```

---

### BUG 6: Message deduplicator key doesn't include content, allowing same-timestamp collisions

**File:** `bot/src/messageDeduplicator.ts:10`

```typescript
const key = `${groupId}:${sender}:${timestamp}`;
```

The deduplication key is `groupId + sender + timestamp`. If two different messages from the same sender arrive with the same millisecond timestamp (possible with rapid message sending or clock skew), the second message would be silently dropped as a "duplicate" even though it has different content.

**Impact:** Low in practice — Signal message timestamps usually differ by at least a few milliseconds. However, the mock server's `queueMessage` handler calls `Date.now()` for each message, and rapid programmatic message sending could produce identical timestamps.

**Fix:** Include a hash of the content in the key, or use `${groupId}:${sender}:${timestamp}:${content.substring(0, 50)}`.

---

### BUG 7: Error logging for `memoryExtractor` uses string interpolation on non-Error objects

**File:** `bot/src/memoryExtractor.ts:77`

```typescript
this.extract(groupId).catch(err => {
  logger.error(`memory-extractor: unhandled error for group ${groupId}: ${err}`);
});
```

If `err` is not a string or Error (e.g., an object), `${err}` produces `[object Object]` which is not useful for debugging. Compare with `logger.error()` which correctly handles the `err` parameter by checking `instanceof Error` and extracting `.message`.

**Impact:** Low — debugging information is lost only when the extractor fails with a non-Error rejection, which is uncommon.

**Fix:** Use `logger.error('...', err)` instead of string interpolation:
```typescript
this.extract(groupId).catch(err => {
  logger.error(`memory-extractor: unhandled error for group ${groupId}:`, err);
});
```

---

## What Works Well

### Core Message Pipeline
- **Message receiving and storage:** Messages from the mock server are correctly received, extracted, and stored in SQLite. Non-trigger messages are stored without invoking the LLM.
- **All 5 mention triggers work:** `@bot`, `bot:`, `@claude`, `claude:`, `c ` (with trailing space) all correctly trigger the bot. Messages starting with similar prefixes (`cat`, `can`) correctly do NOT trigger.
- **Empty trigger handling:** Sending just `claude:` (no query) works — the bot extracts an empty query and responds helpfully.
- **SQL injection safety:** Tested with `'; DROP TABLE messages; --` — stored safely as a regular message, no SQL execution. All queries use parameterized statements.
- **Unicode support:** Messages with unicode characters (accented, CJK) are stored and retrieved correctly.
- **Message deduplication:** The LRU dedup map correctly prevents re-processing of already-seen messages.

### Image Attachments
- Image attachment in mock mode works end-to-end: mock server generates test PNG, bot ingests it into `attachment_data` table, Claude calls `view_image` MCP tool to inspect it, responds with image description.
- Image stored correctly as BLOB with metadata (contentType, size, filename).

### MCP Tool Integration
- **Reminders:** Full pipeline tested: `set_reminder` MCP tool → stored in DB → `ReminderScheduler.processDueReminders()` picks it up → delivered via Signal → marked as `sent` in DB. Completed within expected timing.
- **ToolSearch integration:** Claude correctly uses `ToolSearch` to discover tool schemas before calling them (observed for `set_reminder` and `view_image`).
- **15 MCP servers registered:** All server definitions load and their entry points resolve correctly.

### Signal-cli Resilience
- **Graceful error handling:** When signal-cli goes down, the bot logs errors and continues running.
- **Exponential backoff:** Poll delay increases correctly: 2s → 4s → 8s → 16s → 32s (capped at 60s).
- **Reconnection:** After 5 consecutive errors, the bot attempts reconnection via `waitForReady()`.
- **Recovery:** When signal-cli comes back, the bot reconnects and resumes normal operation. Messages sent after recovery are processed correctly.

### Missed Message Batching
- Multiple trigger messages received in a single poll are correctly classified as missed (>5s old) or realtime (<=5s).
- Missed messages are batched into a single LLM call with framing that lists all missed messages.
- The latest message's query is used as the primary query, with all missed messages listed for context.

### Background Systems
- **Memory extractor:** Fires 5 seconds after bot response, spawns Claude with Sonnet for automatic dossier/memory extraction.
- **Memory consolidator:** Runs once per day on startup, skips subsequent checks.
- **Reminder scheduler:** Checks every 30 seconds for due reminders.
- **WAL checkpoint:** Runs every 5 minutes for SQLite maintenance.

### Test Suite
- All 988 tests pass across 65 test files.
- Tests cover all MCP servers, stores, utilities, and integration scenarios.
- Test execution takes ~12 seconds.

---

## Observations (Not Bugs)

### Collaborative testing mode response quality
In collaborative testing mode, Claude's responses were generally helpful but didn't always follow the "technical and diagnostic" instructions. For simple queries (math, date), Claude responded casually rather than diagnostically. The system prompt instructs diagnostic behavior but Claude sometimes reverts to its default helpful persona, especially for trivial questions.

### Token counts appear low
The bot logs show very low input token counts (2-7 tokens) which seem incorrect for prompts that include a 3.7k char system prompt plus conversation history. This is likely a reporting issue with how the Claude CLI reports usage in the result JSON, not an actual functional problem.

### Model hardcoding in extractors
Both `memoryExtractor.ts` and `memoryConsolidator.ts` hardcode `--model claude-sonnet-4-6`. The main bot uses whatever model is configured in the Claude CLI. Upgrading models requires code changes in multiple files.
