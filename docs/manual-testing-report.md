# Manual Testing Report

**Date:** 2026-04-11
**Branch:** `feature/management-dashboard`
**Tester:** Claude (automated mock testing)
**Environment:** Mock signal-cli server on port 9090, dashboard on port 3333, test database `data/test-manual.db`

## Summary

Comprehensive manual testing of the bot core (via mock signal-cli) and management dashboard (API and frontend). 996 unit tests pass, TypeScript build is clean, 8 lint warnings (non-null assertions in tests only).

**Total issues found: 9**
- Critical: 1
- High: 2
- Medium: 4
- Low: 2

---

## Bot Core Testing

### Tests Performed

| Test | Result | Notes |
|------|--------|-------|
| `claude:` trigger | PASS | Response received, message stored |
| `@bot` trigger | PASS | Response received, message stored |
| `bot:` trigger | PASS | Response received, message stored |
| `@claude` trigger | PASS | Response received, message stored |
| `c ` trigger (trailing space) | PASS | Response received, message stored |
| Non-triggered message | PASS | Stored but no response generated |
| Empty trigger (`claude:` with no query) | PASS | Bot gracefully offered to help |
| Image attachment | PASS | Bot used `view_image` MCP tool, described image accurately |
| Reminder creation | PASS | MCP `set_reminder` tool called, reminder stored and fired on time |
| Weather query | PASS | MCP `search_location` + `get_observations` tools called, real BOM data returned |
| Persona change | PASS | Changed to "Pirate Captain", bot responded in pirate speak |
| Long message (3000+ chars) | PASS | Processed and responded correctly |
| Special characters (emoji, accents, `<>&"`) | PASS | All preserved correctly |
| Multiline message | PASS | Newlines preserved and processed |
| Reminder delivery | PASS | Fired ~2 seconds after due time |

### Bot Issues Found

#### B1. Duplicate responses for concurrent realtime messages [MEDIUM]

**Steps to reproduce:** Send 3+ triggered messages in rapid succession (within the same polling interval).

**Expected:** Bot batches the messages and responds once.

**Actual:** Each message gets its own LLM call. The first LLM call sees all messages in context and addresses all of them. Subsequent calls produce redundant individual responses for messages already addressed.

**Root cause:** `handleMessageBatch()` classifies messages as "realtime" when `Date.now() - timestamp <= 5000ms`. Realtime messages are processed individually in a loop (lines 247-260 of `messageHandler.ts`), even when multiple arrive in the same batch.

**Impact:** Wastes LLM tokens, sends redundant responses to the group, potentially confusing to users.

#### B2. Tool notifications + LLM response = duplicate information [LOW]

**Observed:** When setting a reminder with tool notifications enabled, the bot sends two messages:
1. Tool notification: `"Done — Reminder #1 set for 11/04/2026, 1:47:52 pm: 'Take the bins out! 🗑️'"`
2. LLM response: `"Done! I've set a reminder for 1:47 PM (about 2 minutes from now) to take the bins out. 🗑️"`

**Note:** This is by design (tool notifications provide immediate feedback), but the two messages convey redundant information. Consider having the LLM system prompt mention that a notification was already sent, so the LLM can avoid repeating the same info.

#### B3. All responses use fallback delivery path [INFO]

**Observed:** Every response logged `delivery: sent via fallback` rather than `delivery: sent via MCP`. The bot has a `send_message` MCP tool, but Claude consistently returns the response via the `result` field instead of calling the tool.

**Note:** This was flagged in the previous testing report. The fallback path works correctly, but the intended MCP-first architecture is not being used. This is a Claude behavior issue, not a code bug.

---

## Dashboard API Testing

### Tests Performed

| Endpoint | Method | Result | Notes |
|----------|--------|--------|-------|
| `/api/health` | GET | PASS | Returns uptime, memory, dbSize, signalCliReachable |
| `/api/stats` | GET | PASS | Returns groupCount, reminderCount, attachmentCount/Size |
| `/api/groups` | GET | PASS | Returns enriched groups with settings, persona, messageCount |
| `/api/groups/:id` | GET | PASS | Returns group detail with settings and active persona |
| `/api/groups/:id/settings` | PATCH | PARTIAL | See D1, D2 |
| `/api/groups/:id/leave` | POST | PASS | Calls quitGroup and disables group |
| `/api/groups/join` | POST | PASS | Validates URI format correctly |
| `/api/groups/:id/persona` | POST | PASS | Sets active persona |
| `/api/personas` | GET | PASS | Lists all personas |
| `/api/personas` | POST | PASS | Creates persona, validates empty name |
| `/api/personas/:id` | PUT | PASS | Updates persona |
| `/api/personas/:id` | DELETE | PASS | Returns 404 for non-existent |
| `/api/reminders` | GET | PASS | Lists reminders with correct fields |
| `/api/reminders/:id` | DELETE | PASS | Returns 404 for non-existent |
| `/api/recurring-reminders` | GET | PASS | Returns empty array correctly |
| `/api/dossiers` | GET | PASS | Lists dossiers |
| `/api/dossiers/:gid/:pid` | GET | PASS | Returns specific dossier |
| `/api/dossiers/:gid/:pid` | PUT | PASS | Creates and updates dossiers |
| `/api/dossiers/:gid/:pid` | DELETE | PASS | Deletes correctly |
| `/api/memories` | GET | PASS | Lists memories |
| `/api/memories/:gid/:topic` | PUT | PASS | Creates and updates memories |
| `/api/memories/:gid/:topic` | DELETE | PASS | Deletes correctly |
| `/api/messages` | GET | PASS | Requires groupId, supports search |
| `/api/attachments` | GET | PASS | Lists attachment metadata |
| `/api/attachments/stats` | GET | PASS | Returns size by group |
| `/api/attachments/:id/image` | GET | PASS | Returns image binary with correct content-type |
| `/api/attachments/:id` | DELETE | PASS | Deletes correctly |
| `/api/factory/runs` | GET | PASS | Returns factory run data |
| WebSocket `/ws` | CONNECT | PASS | Connects and accepts messages |
| Frontend static files | GET | PASS | HTML, JS, CSS all served correctly |
| SPA routing | GET | PASS | All routes return index.html |

### Dashboard Issues Found

#### D1. Custom triggers stored as string instead of array [CRITICAL]

**Steps to reproduce:**
```bash
curl -X PATCH "/api/groups/:id/settings" \
  -H 'Content-Type: application/json' \
  -d '{"customTriggers":"hey bot,yo bot"}'
```

**Expected:** Stored as JSON array `["hey bot","yo bot"]`.

**Actual:** Stored as double-JSON-encoded string `"\"hey bot,yo bot\""`. When read back via `getTriggers()`, `JSON.parse()` returns the string `"hey bot,yo bot"` instead of an array, and the `as string[]` cast is incorrect.

**Root cause:** The dashboard PATCH route (`dashboard/src/routes/groups.ts:102`) passes the raw request body string directly to `groupSettingsStore.upsert()`, which expects `string[] | null`. The store then calls `JSON.stringify()` on the string, double-encoding it.

**Impact:** Custom triggers set via the dashboard will not work. The `MentionDetector` receives a single string instead of an array of trigger patterns, causing the bot to fail trigger matching for that group.

**Fix:** The dashboard route should split the comma-separated string into an array, or the frontend should send an array.

#### D2. contextWindowSize accepts negative values [HIGH]

**Steps to reproduce:**
```bash
curl -X PATCH "/api/groups/:id/settings" \
  -H 'Content-Type: application/json' \
  -d '{"contextWindowSize":-5}'
```

**Expected:** Returns 400 with validation error.

**Actual:** Accepts and stores `-5` as the context window size. Returns HTTP 200.

**Root cause:** No validation on `contextWindowSize` in the PATCH route or the store's `upsert()` method.

**Impact:** A negative context window size would cause `getRecentMessages()` to return 0 messages, effectively breaking conversation context for that group.

#### D3. Messages API returns oldest-first when using limit [HIGH]

**Steps to reproduce:**
```bash
curl "/api/messages?groupId=...&limit=3"
```

**Expected:** Returns the 3 most recent messages.

**Actual:** Returns the 3 oldest messages. The underlying SQL query uses `ORDER BY timestamp ASC LIMIT ?` (`messageStore.ts:92`).

**Impact:** Dashboard message view with pagination shows old messages first, making it difficult for users to see recent activity. A user viewing messages with a limit won't see the latest conversation.

**Fix:** Either change the query to `ORDER BY timestamp DESC LIMIT ?` and reverse the result array, or add a `sort` query parameter to the API.

#### D4. Persona creation accepts arbitrarily long names [MEDIUM]

**Steps to reproduce:**
```bash
curl -X POST "/api/personas" \
  -H 'Content-Type: application/json' \
  -d '{"name":"AAAA...(10000 chars)...","description":"test","tags":"x"}'
```

**Expected:** Returns 400 with a length validation error.

**Actual:** Accepts the 10,000-character name. (In this specific test it failed due to missing `tags` field, but the name itself would be accepted.)

**Root cause:** No length validation on persona name or description fields.

**Impact:** Could cause display issues in the dashboard and in Signal messages, storage bloat.

#### D5. Persona creation missing `tags` field gives misleading error [MEDIUM]

**Steps to reproduce:**
```bash
curl -X POST "/api/personas" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Test","description":"test"}'
```

**Expected:** Returns 400 with `"tags is required"` error.

**Actual:** Returns 500 with `"Failed to create persona: NOT NULL constraint failed: personas.tags"`. The raw SQLite error leaks through.

**Root cause:** No validation for required `tags` field in the personas route. The SQL NOT NULL constraint is the only guard.

**Impact:** Poor UX — the error message exposes implementation details (SQLite constraint names) instead of a user-friendly message.

#### D6. Stored XSS risk via persona names [MEDIUM]

**Steps to reproduce:**
```bash
curl -X POST "/api/personas" \
  -H 'Content-Type: application/json' \
  -d '{"name":"<script>alert(1)</script>","description":"xss test","tags":"xss"}'
```

**Actual:** Persona created with HTML/script content as the name. React escapes output by default, so the dashboard frontend is protected, but if persona data is consumed elsewhere (e.g., logs, Signal messages, external tools), the unsanitized content could be a risk.

**Recommendation:** Sanitize or validate persona names to reject HTML/script content on input.

---

## Security Testing

| Test | Result | Notes |
|------|--------|-------|
| SQL injection in message search | PASS | Parameterized queries prevent injection |
| XSS in persona creation | PARTIAL | Stored but React escapes on render (see D6) |
| Large limit parameter | PASS | Capped at 200 by API |
| Missing Content-Type header | PASS | Validation catches missing fields |
| Signal group invite URI validation | PASS | Rejects invalid formats |

---

## Environment/Infrastructure Notes

- **Multiple bot instances:** An old bot process (from a previous session) was found polling the same mock server, stealing messages from the queue. This is a known operational risk documented in CLAUDE.md ("Only one instance should listen to Signal at a time"). Consider adding a PID file or lock mechanism to prevent concurrent instances.

- **Test database isolation:** The `dev:mock` script correctly uses a separate database (`data/mock-bot.db`), but manually starting the bot with `npx tsx src/index.ts` uses the default database unless `DB_PATH` is explicitly set. This is a footgun for testing.

---

## Recommendations

1. **Fix D1 (critical):** Parse comma-separated custom triggers string into an array in the dashboard PATCH route before passing to the store.
2. **Fix D2 and D3 (high):** Add validation for contextWindowSize (must be positive integer). Change messages query to return newest-first or add sort parameter.
3. **Address B1 (medium):** Consider deduplicating realtime messages in the same batch — if multiple mentions arrive together, batch them into one LLM call similar to the missed-message path.
4. **Add input validation (medium):** Validate field lengths (persona names, descriptions) and required fields (tags) at the route level before hitting the database.
5. **Consider PID file/lock:** Prevent multiple bot instances from polling the same signal-cli endpoint simultaneously.
