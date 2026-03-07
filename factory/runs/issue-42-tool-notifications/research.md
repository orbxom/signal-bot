# Research Notes: Issue #42 — MCP Tool Signal Notifications with Per-Group Toggle

## Issue Summary

Add optional Signal message notifications when MCP tools are invoked, controlled per-group. When enabled, tools send a brief confirmation message to the Signal group (e.g. "Reminder set for 3pm"). A new MCP tool toggles the setting. The `creating-mcp-tools` skill must be updated to document the pattern.

Key constraints from the acceptance criteria:
- Default: off (opt-in per group)
- Shared utility — not duplicated per server
- Skip notifications for `toggle_tool_notifications` itself (avoid loops)
- Skip notifications for `send_message` / `send_image` (redundant)
- Notify on failure too (silence should not mean "still working")
- Notifications should be visually distinguishable from regular bot responses

---

## 1. better-sqlite3 — Database Layer

### Current Project Patterns

The project uses `better-sqlite3` with WAL mode, managed via `bot/src/db.ts`:

**Schema versioning:** Uses a `schema_meta` table with a `schema_version` key. Migrations are sequential methods (`migrateToV1()` through `migrateToV5()`), each checked with `if (currentVersion < N)`.

**Two migration patterns are in use:**

1. **ADD COLUMN** (V1, V2) — Used when extending an existing table:
   ```typescript
   // V1: Check column exists first, then ALTER TABLE
   const cols = this.db.pragma('table_info(messages)') as Array<{ name: string }>;
   if (!cols.some(c => c.name === 'attachments')) {
     this.db.exec('ALTER TABLE messages ADD COLUMN attachments TEXT');
   }
   ```

2. **CREATE TABLE** (V3, V4, V5) — Used for new domain entities:
   ```typescript
   // V5: New table with CREATE TABLE IF NOT EXISTS + indexes
   this.db.exec(`
     CREATE TABLE IF NOT EXISTS recurring_reminders (...);
     CREATE INDEX IF NOT EXISTS idx_recurring_status_due ON ...;
   `);
   ```

**Store pattern:** Each domain has a store class in `bot/src/stores/` that:
- Takes a `DatabaseConnection` in its constructor
- Pre-compiles prepared statements in the constructor (`conn.db.prepare(...)`)
- Uses `conn.runOp(name, fn)` or `conn.ensureOpen()` + try/catch for operations
- Wraps errors with `wrapSqliteError()`

### Recommendation for This Feature

**New table vs. add column:** A per-group toggle is a new concept — it maps naturally to a new table (like `active_personas`). This avoids coupling to any existing table and allows future expansion (e.g., notification preferences, filter patterns).

**Proposed schema:**
```sql
CREATE TABLE IF NOT EXISTS group_settings (
  groupId TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updatedAt INTEGER NOT NULL,
  PRIMARY KEY (groupId, key)
);
```

A generic `group_settings` table is more flexible than a single-purpose table — future per-group settings (e.g., verbosity, mention triggers) can reuse it. However, a dedicated `tool_notification_settings` table is simpler and avoids over-engineering.

**Migration:** This would be `migrateToV6()` in `db.ts`.

### better-sqlite3 API Reference

Key methods used in this project:
- `new Database(path)` — Opens/creates database
- `db.pragma('journal_mode = WAL')` — Sets WAL mode
- `db.exec(sql)` — Executes multi-statement SQL (used for DDL/migrations)
- `db.prepare(sql)` — Creates a prepared statement (returns `Statement`)
- `stmt.run(...params)` — Execute, returns `{ changes, lastInsertRowid }`
- `stmt.get(...params)` — Returns first row or `undefined`
- `stmt.all(...params)` — Returns all rows as array
- `db.pragma('table_info(tableName)')` — Returns column metadata (used for migration guards)
- `db.transaction(fn)` — Wraps function in BEGIN/COMMIT (with automatic ROLLBACK on error)

### Gotchas

- **SQLite ALTER TABLE limitations:** Cannot add columns with PRIMARY KEY, UNIQUE, or NOT NULL without a default. New columns are always appended to the end.
- **WAL mode:** Already enabled. Multiple readers are fine; only one writer at a time. The MCP servers each open their own `DatabaseConnection`, so they share the SQLite file but not the JS object.
- **Each MCP server is a separate process** — they each create their own `DatabaseConnection`. The notification utility will need to read the setting from the DB within the same process that handles the tool call.

Sources:
- [better-sqlite3 API docs](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md)
- [SQLite ALTER TABLE](https://sqlite.org/lang_altertable.html)
- [better-sqlite3 on npm](https://www.npmjs.com/package/better-sqlite3)

---

## 2. MCP (Model Context Protocol) — Tool Definitions and Server Architecture

### Current Project Patterns

**Tool definition structure** (from `bot/src/mcp/types.ts`):
```typescript
interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}
```

**Server definition** (`McpServerDefinition`):
- `serverName` — Protocol identity
- `configKey` — Used in MCP config key and tool name prefix (`mcp__<configKey>__<toolName>`)
- `entrypoint` — Filename (without path), registry prepends `servers/`
- `tools` — Array of `ToolDefinition`
- `handlers` — Map of tool name to handler function
- `envMapping` — Maps env vars to `MessageContext` fields
- `onInit()` / `onClose()` — Lifecycle hooks

**Protocol handler** (`bot/src/mcp/runServer.ts`):
- Uses protocol version `2025-03-26`
- Reads line-delimited JSON from stdin, writes to stdout
- Handles: `initialize`, `notifications/initialized`, `tools/list`, `tools/call`
- Unknown methods with an `id` get `-32601` error response

**Registry** (`bot/src/mcp/registry.ts`):
- `ALL_SERVERS` array in `bot/src/mcp/servers/index.ts` — add one import to register
- `buildAllowedTools()` — Concatenates all tool names with `mcp__<configKey>__` prefix
- `buildMcpConfig()` — Builds the MCP config JSON passed to `claude -p`
- Each server gets env vars mapped from `MessageContext` fields

**Adding a new tool to an existing server:** Just add to the `TOOLS` array and `handlers` object in the server file. No other files change.

**Adding a new server:** Create file in `bot/src/mcp/servers/`, export `McpServerDefinition`, add one import to `servers/index.ts`.

### MCP Protocol Specification

The MCP spec (latest: 2025-11-25) uses JSON-RPC 2.0:

**tools/list response:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "tools": [
      {
        "name": "tool_name",
        "description": "What it does",
        "inputSchema": {
          "type": "object",
          "properties": { ... },
          "required": [...]
        }
      }
    ]
  }
}
```

**tools/call request:**
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "tool_name",
    "arguments": { "param1": "value" }
  }
}
```

**tools/call response:**
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "content": [{ "type": "text", "text": "Result" }],
    "isError": false
  }
}
```

### Recommendation for This Feature

**Option A: New dedicated MCP server** for notification settings — cleanest separation but adds overhead (another subprocess).

**Option B: Add tools to an existing server** — the `signal` server already has Signal-sending capability and env vars. Adding `toggle_tool_notifications` and `get_tool_notification_status` there avoids a new process. However, the signal server currently doesn't open a DB connection.

**Option C: New server** that owns both the toggle tool and the shared notification utility. Other servers import the utility.

**Key architectural consideration:** The notification utility must be usable from *within* any MCP server process. Since each MCP server is a separate process (spawned by Claude CLI), the utility cannot be a shared in-memory singleton. It must:
1. Read the per-group setting from the DB (each server already has `DB_PATH` and `MCP_GROUP_ID`)
2. Send a Signal message via HTTP (needs `SIGNAL_CLI_URL` and `SIGNAL_ACCOUNT`)

This means the utility is a **shared module** imported by each server, not a separate process. Each server that wants notifications will need `SIGNAL_CLI_URL` and `SIGNAL_ACCOUNT` in its `envMapping`.

**The dark factory server already has this exact pattern** — it has its own `sendSignalNotification()` function that does fetch to signal-cli. The new feature generalizes this into a shared utility.

Sources:
- [MCP Specification](https://modelcontextprotocol.io/specification/2025-11-25)
- [MCP Tools Spec](https://modelcontextprotocol.io/specification/draft/server/tools)
- [MCP Server Development Guide](https://github.com/cyanheads/model-context-protocol-resources/blob/main/guides/mcp-server-development-guide.md)

---

## 3. Signal-cli REST API — Sending Messages

### Current Project Patterns

The bot communicates with signal-cli via JSON-RPC over HTTP. Two implementations exist:

**1. Main bot** (`bot/src/signalClient.ts`):
```typescript
private async rpc<T>(method: string, params: Record<string, unknown>, timeoutMs = 30000): Promise<T> {
  const response = await fetch(`${this.baseUrl}/api/v1/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method,
      params: { account: this.account, ...params },
      id: `${Date.now()}-${++this.requestIdCounter}`,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  // ... error handling
}
```

**2. MCP servers** (signal.ts, darkFactory.ts) — duplicate the fetch pattern inline:
```typescript
async function signalRpc(method: string, params: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${signalCliUrl}/api/v1/rpc`, { ... });
}
```

### signal-cli JSON-RPC API

**Endpoint:** `POST /api/v1/rpc`

**Send method parameters:**
- `account` — The sender phone number
- `message` — Text content
- `groupId` — Target group (base64 group ID)
- `attachments` — Array of file paths or data URIs
- `recipients` — Array of phone numbers (for DMs, not used here)

**Example request:**
```json
{
  "jsonrpc": "2.0",
  "id": "unique-id",
  "method": "send",
  "params": {
    "account": "+61400000000",
    "groupId": "base64groupid==",
    "message": "Hello from the bot"
  }
}
```

**Parameter naming:** camelCase in JSON-RPC (vs. kebab-case on CLI). e.g., `groupId` not `group-id`.

### Recommendation for This Feature

The notification utility should:
1. Accept `signalCliUrl`, `signalAccount`, `groupId`, and the notification message
2. Check the DB for the per-group setting before sending
3. Use a short timeout (5-10 seconds) — notifications are best-effort
4. Silently swallow errors (log to stderr) — a failed notification should not break the tool
5. Be async and non-blocking from the tool handler's perspective

**Message formatting:** The issue says notifications should be "clearly distinguishable." Options:
- Prefix: e.g., `[tool] Reminder set for 3pm`
- Emoji prefix (common in bots): not preferred per project style
- Indented or bracketed format

The dark factory server already uses plain messages for its notifications (`"Dark factory starting for issue #42..."`). A consistent prefix like `[tool]` or similar would work.

Sources:
- [signal-cli JSON-RPC docs](https://github.com/AsamK/signal-cli/blob/master/man/signal-cli-jsonrpc.5.adoc)
- [signal-cli-rest-api](https://github.com/bbernhard/signal-cli-rest-api)
- [signal-cli JSON-RPC discussion](https://github.com/AsamK/signal-cli/discussions/679)

---

## 4. Existing `creating-mcp-tools` Skill — Current Structure

**File:** `/home/zknowles/personal/signal-bot/.claude/skills/creating-mcp-tools/SKILL.md`

### Current Sections

1. **Overview** — MCP tools are standalone stdio JSON-RPC 2.0 servers, language-agnostic, auto-discovered
2. **Safety Rules** — Files safe/unsafe to modify while bot runs
3. **TDD Requirements** — Tests FIRST, strict enforcement
4. **Creating a TypeScript MCP Tool** (Steps 1-6):
   - Step 1: Write test file (with DB-backed variant)
   - Step 2: Watch tests fail (RED)
   - Step 3: Write server file (template code, key interfaces table)
   - Step 4: Watch tests pass (GREEN)
   - Step 5: Register in barrel export
   - Step 6: Verify everything
5. **Creating a Non-TypeScript MCP Tool** — Protocol requirements, external server registration
6. **Key File References** — Table of files and their purposes
7. **Common Rationalizations** — Anti-excuses for skipping TDD
8. **Red Flags** — Signs you're doing it wrong

### What Needs Updating

Per the issue: "Update the `creating-mcp-tools` skill to document how new MCP servers should integrate with the notification system."

Additions needed:
1. **New section** (after Step 3 or as a subsection): "Integrating Tool Notifications"
   - How to import the shared notification utility
   - How to call it from a handler (after the tool action succeeds/fails)
   - Which env vars to add to `envMapping` (`SIGNAL_CLI_URL`, `SIGNAL_ACCOUNT`)
   - Which tools should NOT send notifications (toggle tool itself, send_message, send_image)
   - Example code snippet showing the pattern

2. **Update Key File References** table to include:
   - The new notification utility module
   - The new store (if a separate store class is created)

3. **Update Step 3 template** — The `envMapping` example should mention the Signal env vars if the server will use notifications

---

## 5. Architecture Recommendation Summary

### Proposed File Changes

| File | Change | Purpose |
|------|--------|---------|
| `bot/src/db.ts` | Add `migrateToV6()` | New table for per-group tool notification setting |
| `bot/src/stores/groupSettingsStore.ts` | **New file** | Store class for reading/writing group settings |
| `bot/src/mcp/notify.ts` | **New file** | Shared notification utility: checks setting, sends Signal message |
| `bot/src/mcp/servers/signal.ts` | Add 2 tools | `toggle_tool_notifications`, `get_tool_notification_status` |
| `bot/src/mcp/servers/*.ts` | Add notification calls | Each server calls `notify()` after tool actions |
| `bot/src/mcp/validate.ts` | Add `requireBoolean()` | For the toggle tool's on/off parameter |
| `bot/src/types.ts` | (Possibly) add type | If a `GroupSetting` type is needed |
| `.claude/skills/creating-mcp-tools/SKILL.md` | Add section | Document notification integration pattern |

### Shared Notification Utility Design

```
bot/src/mcp/notify.ts
  - init(config: { dbPath, signalCliUrl, signalAccount, groupId })
  - notify(toolName: string, message: string): Promise<void>
    1. Check if groupId has notifications enabled (DB lookup, cached)
    2. If not enabled, return immediately
    3. If tool is in skip list (toggle_tool_notifications, send_message, send_image), return
    4. Format message with prefix
    5. POST to signal-cli /api/v1/rpc
    6. Log errors to stderr, never throw
```

### Env Mapping Impact

Every MCP server that wants to send notifications will need these env vars:
- `SIGNAL_CLI_URL` → `signalCliUrl`
- `SIGNAL_ACCOUNT` → `botPhoneNumber`
- `DB_PATH` → `dbPath` (most already have this)
- `MCP_GROUP_ID` → `groupId` (all already have this)

Servers that already have `SIGNAL_CLI_URL`: `signal`, `darkFactory`
Servers that need it added: `reminders`, `weather`, `github`, `dossiers`, `sourceCode`, `messageHistory`, `images`, `personas`, `memories`

---

## 6. Codebase Analysis — Detailed Findings

### Dark Factory's Existing Notification Pattern (Key Discovery)

`bot/src/mcp/servers/darkFactory.ts` already has an inline `sendSignalNotification()` function (lines 14-34) that:
- Reads `signalCliUrl`, `signalAccount`, `groupId` from module-level variables
- POSTs to signal-cli JSON-RPC endpoint
- Silently fails on error (catch-and-log)
- Currently sends one notification: "Dark factory starting for issue #..."

**This is the exact pattern to extract into the shared utility.** The refactoring replaces this inline function with an import of the shared `notify()` module.

### Which Servers Need Notifications (Analysis)

| Server | State-changing? | Needs notifications? | Notes |
|--------|----------------|---------------------|-------|
| `reminders.ts` | Yes (set/cancel reminders) | YES | 6 tools, all modify state |
| `dossiers.ts` | Yes (CRUD) | YES | 3 tools |
| `personas.ts` | Yes (CRUD + switch) | YES | 6 tools |
| `github.ts` | Yes (create issue, comment, review, merge) | YES | 7 tools, some are read-only (list/view/diff) |
| `darkFactory.ts` | Yes (start factory) | YES | Already has inline notification — refactor |
| `weather.ts` | No (read-only) | YES (per AC) | AC says "all existing MCP servers" |
| `sourceCode.ts` | No (read-only) | YES (per AC) | AC says "all existing MCP servers" |
| `messageHistory.ts` | No (read-only) | YES (per AC) | AC says "all existing MCP servers" |
| `images.ts` | No (read-only) | YES (per AC) | AC says "all existing MCP servers" |
| `signal.ts` | Yes (send messages) | NO | Explicitly excluded — the message IS the notification |
| `settings.ts` (new) | Yes (toggle setting) | NO | Explicitly excluded — avoid loops |

**Note:** The acceptance criteria says "Existing MCP servers are updated to use the notification mechanism" — this includes read-only servers. For read-only tools, notifications would be like "Searched message history for 'keyword'" which may be noisy. The devil's advocate review should challenge whether read-only tools truly need notifications.

### MCP Server Environment Pattern

Each server's `envMapping` maps env var names to `MessageContext` fields:
```typescript
envMapping: {
  DB_PATH: 'dbPath',
  MCP_GROUP_ID: 'groupId',
  // Notification support requires adding:
  SIGNAL_CLI_URL: 'signalCliUrl',
  SIGNAL_ACCOUNT: 'botPhoneNumber',
}
```

The `buildMcpConfig()` in `registry.ts` reads these mappings and sets env vars when spawning the subprocess.

### Test Patterns

Tests are in `bot/src/__tests__/` using Vitest. Key patterns:
- In-memory SQLite databases for store tests
- Direct function testing for MCP handlers
- Mocking of external services (signal-cli)

---

## 7. Prior Art — Conflicts and Related Work

### Related Designs in `docs/plans/`

- **`2026-03-06-group-memory-design.md`** — Established pattern for adding per-group features: new table via migration, new store class, Storage facade methods, MCP server. Issue #42 should follow this playbook.
- **Dark factory plans** — No conflict. The dark factory's inline `sendSignalNotification()` will be replaced by the shared utility.

### Recent Git History

No in-flight changes that conflict. Recent merges (PR #39 dark factory MCP, PR #38 recurring reminders, PR #37 GitHub PR tools) are all complete and stable on master.

### Open Issues — Interactions

| Issue | Impact |
|-------|--------|
| #41 (prompt-mode reminders) | Could benefit from notifications when prompt-mode reminders complete |
| #40 (dark factory input) | No conflict; dark factory server will need updating |
| #36 (health check server) | New server would need notification integration if built after #42 |

### Existing Per-Group Patterns (Models to Follow)

**`active_personas` table** — Closest pattern for per-group toggle:
- `groupId TEXT NOT NULL PRIMARY KEY`
- UPSERT pattern: `ON CONFLICT(groupId) DO UPDATE SET`
- Methods: `setActive()`, `getActiveForGroup()`, `clearActive()`

**Reminders** — Per-group scoping via `groupId` column + query filters.

### Existing Notification Patterns

1. **Dark factory inline** — `sendSignalNotification()` in MCP server (to be replaced)
2. **ReminderScheduler failure notifications** — App-level `signalClient.sendMessage()` with emoji prefix. Different layer; should NOT be replaced.
3. **Signal MCP `signalRpc()`** — Reusable fetch pattern for signal-cli JSON-RPC

---

## 8. Key Design Decisions to Make

1. **Generic `group_settings` table vs dedicated `tool_notification_settings` table?** — Generic is more flexible but risks over-engineering for one boolean.

2. **Where does the toggle tool live?** — Options: new `settings.ts` server, add to `signal.ts`, or add to a new server. New server is cleanest.

3. **Notifications for read-only tools?** — AC says all servers, but notifying "Viewed image attachment" is noisy. Need to decide granularity.

4. **Notification message format** — Prefix like `[tool]` or other visual distinction?

5. **DB caching in the notification utility** — Query per-tool-call or cache the setting for the process lifetime? Given MCP servers are short-lived subprocesses, caching for process lifetime is reasonable.
