# Devil's Advocate Review: Issue #42 — MCP Tool Signal Notifications

## Critical Issues

### 1. `withNotification` changes error handling semantics — behavioral regression risk

The plan says `withNotification` is a "drop-in replacement for `catchErrors()`," but it is not behaviorally equivalent. Look at the actual `catchErrors` in `/home/zknowles/personal/signal-bot/bot/src/mcp/result.ts` (lines 17-34):

```typescript
export function catchErrors(
  fn: () => ToolResult | Promise<ToolResult>,
  prefix?: string,
): ToolResult | Promise<ToolResult> {
```

Key differences:

**a) `catchErrors` can return synchronously; `withNotification` always returns a Promise.**

`catchErrors` checks `if (result instanceof Promise)` and returns synchronously when the inner function is synchronous. Many handlers (e.g., `list_reminders`, `cancel_reminder`, `list_recurring_reminders`, `cancel_recurring_reminder`, all of `memories.ts`, `dossiers.ts`) use synchronous functions inside `catchErrors`. The `ToolHandler` type signature is `(args) => ToolResult | Promise<ToolResult>`, so returning a Promise where a synchronous result was returned before is technically compatible, but it changes the execution timing. The MCP `runServer.ts` presumably awaits the handler result, so this should be fine in practice — but it needs verification, not assumption.

**b) `catchErrors` supports an error prefix parameter; `withNotification` does not pass it through.**

Look at the plan's `withNotification` (plan.md lines 314-334): when an error is caught, it calls `error(msg)` where `msg` is `getErrorMessage(err)` — it loses the prefix entirely. Current code like `catchErrors(fn, 'Failed to set reminder')` prepends "Failed to set reminder:" to the error message returned to the LLM. The `withNotification` version sends the prefix as a *notification* (`onError`) but the tool result returned to Claude loses the prefix context.

**Fix:** Either make `withNotification` also prepend `onError` to the error result, or keep `catchErrors` and add notification as a separate concern (see alternative below).

**c) Handlers that do validation *outside* `catchErrors` won't get notifications for validation failures.**

Look at `set_reminder` in `reminders.ts` (lines 105-121):

```typescript
set_reminder(args) {
  const reminderText = requireString(args, 'reminderText');
  if (reminderText.error) return reminderText.error;  // No notification sent here
  const dueAt = requireNumber(args, 'dueAt');
  if (dueAt.error) return dueAt.error;  // No notification sent here
  ...
  return catchErrors(() => { ... });
}
```

The plan's example (lines 605-616) moves the `requireString` call *outside* `withNotification`, so validation errors silently return without any notification. This violates the AC: "Tools that fail should also notify briefly." The plan doesn't acknowledge or address this gap for any of the servers.

**Fix:** Either move all validation inside `withNotification`, or wrap the entire handler (including validation) rather than just the inner function.

### 2. The plan omits the `memories.ts` server entirely

The barrel file `bot/src/mcp/servers/index.ts` (line 8) imports `memoryServer` from `./memories`, and the `ALL_SERVERS` array (line 20) includes it. The plan's Task 4 (lines 562-570) lists 9 servers to update but does not mention `memories.ts`. The research document (line 368) mentions "memories" in the env mapping impact analysis, but the plan itself has no action item for it. This is a state-changing server (save, delete) that should definitely get notifications.

**Fix:** Add `memories.ts` to the Task 4 server list.

### 3. `withNotification` success message must be known before the handler runs — inflexible API

The plan's API is:
```typescript
withNotification(onSuccess, onError, fn)
```

Look at the plan's example (lines 605-616):
```typescript
set_reminder: (args) => {
  const time = requireString(args, 'time');
  return withNotification(
    `Reminder set for ${time}`,  // Static string, determined before handler runs
    'Failed to set reminder',
    async () => { ... return ok(`Reminder set for ${time}`); }
  );
},
```

This works for simple cases, but what about handlers where the success message depends on the result? For example, `set_reminder` currently returns `ok('Reminder #${id} set for ${formatted}')` — the `id` is only known after the store call. The notification message can't include the reminder ID under this API.

More critically, `set_recurring_reminder` returns a multi-line message with the next 3 cron occurrences. The notification should be brief (`"Recurring reminder #5 set (0 8 * * *)"`), but the ID is computed inside the handler.

**Fix:** Support a function callback for the success message: `onSuccess: string | ((result: ToolResult) => string)`. Or better yet, extract the notification message from the tool result text automatically (e.g., first line), avoiding the need to specify it twice.

---

## Important Issues

### 4. Notifications for read-only tools are noise — question the AC interpretation

The AC says "All existing MCP servers updated to use the notification mechanism." The plan interprets this as adding notifications to weather, sourceCode, messageHistory, and images servers. But consider what the actual notifications would say:

- `[tool] Weather forecast retrieved` -- sent *in addition to* the actual weather data Claude sends
- `[tool] Source code file listed` -- who cares?
- `[tool] Searched message history` -- no one wants this
- `[tool] Image viewed` -- the image content was viewed by Claude, not by the user

These add nothing. The user asked for weather; they'll see the weather in Claude's response. A notification saying "I looked up the weather" is just spam.

The AC more likely means "the notification *mechanism* is available to all servers" (i.e., they import `withNotification`), not that every single tool call should produce a user-visible Signal message. State-changing tools (reminders, dossiers, personas, GitHub actions) benefit from confirmation. Read-only tools do not.

**Recommendation:** Apply `withNotification` only to state-changing tools. Use `catchErrors` for read-only tools (weather lookups, source code browsing, message history search, image viewing). This still satisfies "all existing MCP servers updated" — they're updated to use the notification module, they just use `catchErrors` (which is also exported from the module) for read-only operations. If this is too aggressive, at minimum make the plan explicitly discuss this tradeoff rather than silently adding noisy notifications.

### 5. Opening a separate DB connection per notification is wasteful and fragile

The `notify.ts` module (plan lines 277-282) opens a brand new `Database` connection to read one boolean, then closes it:

```typescript
const db = new Database(DB_PATH, { readonly: true });
try {
  const row = db.prepare('SELECT ...').get(MCP_GROUP_ID);
  cachedEnabled = row ? Boolean(row.enabled) : false;
} finally {
  db.close();
}
```

Problems:
- Every MCP server that uses notifications already opens a `DatabaseConnection` in its `onInit()`. Why open a second connection?
- Using raw `new Database()` bypasses `DatabaseConnection`, so it doesn't get WAL mode pragma, and more importantly, it directly queries a table that might not exist if migrations haven't run yet.
- The raw SQL `SELECT enabled FROM tool_notification_settings WHERE groupId = ?` is duplicated from `ToolNotificationStore`. If the schema changes, this query won't be updated.

**Alternative A (env var):** Have `buildMcpConfig()` in `registry.ts` read the setting from the DB once when spawning the MCP process, and pass `TOOL_NOTIFICATIONS_ENABLED=1` as an env var. The `notify.ts` module just reads the env var — no DB connection needed at all. This is simpler, faster, and avoids all DB-in-notification concerns. The setting would be read at process spawn time (which is per-Claude-invocation), which is perfectly granular enough since a user won't toggle the setting mid-conversation.

**Alternative B (reuse connection):** Pass the `DatabaseConnection` (or just the boolean) from `onInit()` into the notification module via a `configureNotifications(enabled: boolean)` function. No second connection needed.

### 6. The `[tool]` prefix is cryptic and un-user-friendly

The plan uses `[tool]` as the notification prefix (plan line 268). This will appear in a family group chat as messages like:

```
[tool] Reminder set for 3pm
[tool] Failed to set reminder: time must be in the future
```

Real users (a family) will not know what `[tool]` means. They'll wonder why the bot is talking about "tools."

**Alternatives:**
- No prefix — just use distinctive formatting. The notification IS from the bot account, so attribution is already there.
- Use a more human prefix: `[done]`, `[note]`, or contextual prefix like the tool category: `[reminder]`, `[weather]`, `[dossier]`.
- Use a Unicode character for visual distinction: `> Reminder set for 3pm` or `--- Reminder set for 3pm`.

The dark factory currently sends plain messages with no prefix ("Dark factory starting for issue #42...") and it works fine. Why add an ugly bracket prefix?

### 7. The settings MCP server test (Task 3) has fundamental flaws

Looking at the test code in plan lines 366-438:

**a)** The test sets `process.env.DB_PATH = ':memory:'` (line 385) but the `settingsServer.onInit()` will create its own `DatabaseConnection(':memory:')` — which will be a *different* in-memory database from the one the test creates. Two `:memory:` database connections are two completely separate databases. The test calls handlers directly but they'd operate on a different DB than the one the test inspects.

**b)** The test calls `settingsServer.handlers.toggle_tool_notifications(...)` without first calling `settingsServer.onInit()`. The `store` variable (plan line 459) will be `undefined`, causing a runtime crash, not a test failure.

**c)** The test says "Note: The exact test structure may need adjustment" (line 441) — this is a red flag in a plan that claims to be task-by-task TDD. The tests should be correct in the plan, not approximated.

**Fix:** Call `onInit()` in `beforeEach`, use a temp file DB (like the notify test does), and ensure the test's DB reference and the server's DB reference are the same.

### 8. Module-level cache in `notify.ts` has a subtle correctness issue

The `cachedEnabled` variable (plan line 269) caches the setting for the process lifetime. The plan says this is fine because "MCP servers are short-lived subprocesses." But look at how the settings toggle works: the user says "enable tool notifications," which invokes the `settings` MCP server (a subprocess) to write to the DB. Meanwhile, the `reminders` MCP server (a *different* subprocess) has already cached `enabled = false`. The reminders server won't see the change until its process exits and a new one is spawned.

This is probably acceptable since MCP server processes are per-Claude-invocation, but the plan should explicitly acknowledge this limitation. If the user enables notifications and then immediately sets a reminder in the same conversation turn, the reminder server may have already been spawned and cached `false`.

Actually, re-reading the architecture — each `claude -p` invocation spawns MCP servers as child processes. If Claude calls `toggle_tool_notifications` and then `set_reminder` in the same invocation, both MCP servers are already running as separate long-lived processes for that invocation. The toggle will write to DB, but the reminders server already cached `false` at startup. **The notification won't fire for any tool in the same Claude invocation where it was enabled.** This is a real UX issue: user says "enable notifications and set a reminder for 3pm," and the reminder is set but no notification is sent.

**Fix:** Use Alternative A from issue #5 (env var) — this sidesteps the problem because the setting is read at spawn time, before any MCP server starts. For a mid-conversation toggle, the setting would take effect on the next Claude invocation, which is the natural expectation. Or, don't cache — just read from DB every time (a single indexed SQLite read is ~0.01ms; caching is premature optimization).

---

## Minor Issues

### 9. The `enabled` parameter on `toggle_tool_notifications` should not be a boolean

The tool schema uses `type: 'boolean'` for the `enabled` parameter (plan line 484). The handler code (plan line 511) handles this with:
```typescript
const enabled = args.enabled === true || args.enabled === 'true';
```

LLMs are known to occasionally send booleans as strings in JSON. More importantly, a user saying "turn off tool notifications" requires the LLM to map that to `enabled: false`, which is a negative-logic parameter. Using `action: "enable" | "disable"` as an enum string would be clearer for both the LLM and for readability.

### 10. DB table name inconsistency between plan and research

The research recommends either `group_settings` (generic, plan line 57) or `tool_notification_settings` (specific). The plan uses `tool_notification_settings`. This is fine and the right call (YAGNI — build the generic table when there's a second setting), but the research's "Recommendation for This Feature" section still presents both options without a clear verdict, which could confuse the implementer.

### 11. Task 4 says to add `SIGNAL_CLI_URL` and `SIGNAL_ACCOUNT` to envMapping for all servers, but many don't need them

The plan (lines 579-585) says to add these env vars to every server's envMapping. But under Alternative A (env var approach from issue #5), the notification module wouldn't need them — it would just read one env var. Even under the current plan's approach, this adds two unnecessary env vars to servers like `weather.ts` that currently have `envMapping: { TZ: 'timezone' }` (a single timezone var). Every added env mapping is another thing the registry has to resolve and pass through. It's boilerplate explosion across 9+ servers for a notification feature that might be off.

### 12. The plan doesn't address the migration table-not-existing edge case

`notify.ts` runs `SELECT enabled FROM tool_notification_settings WHERE groupId = ?` directly (plan line 280). If the MCP server process somehow starts before the DB migration to v6 runs (e.g., the DB file exists at an older schema version), this query will fail with `SQLITE_ERROR: no such table: tool_notification_settings`.

The `DatabaseConnection` constructor runs migrations automatically, but `notify.ts` uses raw `new Database(DB_PATH, { readonly: true })` — it bypasses `DatabaseConnection` and its migrations entirely. A readonly connection *cannot* run migrations anyway.

**Fix:** Wrap the query in a try/catch and default to `false` if the table doesn't exist. Or use the env var approach (Alternative A) which avoids DB access entirely.

### 13. The `withNotification` function fire-and-forgets the notification but doesn't await it

In the plan's code (lines 318-334), `sendToolNotification(onSuccess)` is called without `await`:

```typescript
} else {
  sendToolNotification(onSuccess);  // No await
}
return result;
```

This means the function returns the tool result before the notification is sent. In practice this is probably fine (the notification is best-effort), but it means:
- If the process exits immediately after returning, the notification may never be sent.
- The ordering is: tool result returned to Claude -> notification may or may not arrive in Signal.

For error cases (line 330), same issue: `sendToolNotification(...)` is not awaited.

This is arguably intentional (fire-and-forget for speed), but should be documented as a conscious choice.

### 14. No rate limiting or deduplication of notifications

If Claude calls the same tool multiple times in rapid succession (e.g., searching message history 5 times), 5 notifications will be sent. Combined with read-only tools getting notifications (issue #4), this could flood the group chat.

There is no mechanism to suppress duplicate or rapid-fire notifications. Consider at minimum a simple "don't send more than N notifications per minute" guard.

### 15. `resetNotificationCache()` is exported only for testing — code smell

The `resetNotificationCache()` function (plan line 337) exists only because the module-level `cachedEnabled` variable needs resetting between tests. This is a test-only API leaking into production code. Under the env var approach (Alternative A), there's no cache to reset and no test-only export needed.

---

## Summary of Recommendations

1. **Don't replace `catchErrors` with `withNotification`.** Instead, compose them: `withNotification` should *wrap* `catchErrors`, or be a separate `sendToolNotification()` call alongside `catchErrors`. This avoids behavioral regression risk.

2. **Pass the notification setting as an env var** from `buildMcpConfig()`, not via a separate DB connection in each MCP process. This eliminates issues #5, #8, #12, and #15 in one stroke.

3. **Only notify for state-changing tools.** Don't add notifications to weather, sourceCode, messageHistory, images, or the read-only operations of github (list/view/diff).

4. **Add `memories.ts`** to the server update list.

5. **Make the success message a callback** so it can include dynamic information (like reminder IDs).

6. **Use a less cryptic prefix** than `[tool]`.

7. **Fix the settings server tests** to actually work (call `onInit()`, use shared DB).

8. **Wrap entire handlers** including validation, not just the inner function, to ensure validation failures are also notified.
