# Health Check MCP Server — Research Notes

## 1. Codebase Patterns (How to Build an MCP Server Here)

### Server Definition Structure
Every MCP server follows this pattern (`McpServerDefinition` from `bot/src/mcp/types.ts`):

```ts
export interface McpServerDefinition {
  serverName: string;        // e.g. 'signal-bot-health'
  configKey: string;         // e.g. 'health' — used as mcp__health__<tool_name>
  entrypoint: string;        // filename only, e.g. 'health' — registry resolves to servers/health.ts
  tools: ToolDefinition[];
  handlers: Record<string, ToolHandler>;
  envMapping: EnvMapping;    // maps env var names -> MessageContext field names
  onInit?: () => void;
  onClose?: () => void;
}
```

### Registration (3 steps)
1. Create `bot/src/mcp/servers/health.ts`
2. Add import + entry to `bot/src/mcp/servers/index.ts` ALL_SERVERS array
3. No other files need to change

### Result Helpers (from `bot/src/mcp/result.ts`)
- `ok(text: string): ToolResult` — success response
- `error(text: string): ToolResult` — error response
- `catchErrors(fn, prefix?)` — wraps sync/async fn, catches and returns error()
- `getErrorMessage(err)` — extracts message from unknown error

### Validation Helpers (from `bot/src/mcp/validate.ts`)
- `requireString(args, name)` — returns `{ value }` or `{ error }`
- `requireNumber(args, name)` — same pattern
- `requireGroupId(groupId)` — returns ToolResult error or null
- `optionalString(args, name, defaultValue)` — returns string

### Environment Variables
- Env vars are injected via `envMapping` on the server definition
- `readStorageEnv()` reads `DB_PATH`, `MCP_GROUP_ID`, `MCP_SENDER` from process.env
- For the health check, we need: `DB_PATH`, `SIGNAL_CLI_URL`, `SIGNAL_ACCOUNT`

### Entry Point Pattern
Every server file ends with:
```ts
if (require.main === module) {
  runServer(healthServer);
}
```

---

## 2. Node.js Process APIs

### `process.uptime()`
- **Returns:** `number` — seconds (with fractional milliseconds) since the Node.js process started
- **Example:** `process.uptime()` might return `12345.678`
- **No arguments, no async, never throws**
- **Formatting note:** Convert to human-readable: days/hours/minutes/seconds
- **Gotcha:** This is the MCP server process uptime, NOT the bot process uptime. Since each MCP server runs as a separate child process (`npx tsx servers/health.ts`), `process.uptime()` measures how long the MCP server process has been alive, not the bot. To get bot uptime, we'd need the bot to pass its start time as an env var (e.g., `BOT_START_TIME`).

### `process.memoryUsage()`
- **Returns:** `object` with these fields (all `number`, in bytes):
  - `rss` — Resident Set Size: total memory allocated for the process (includes code, stack, heap)
  - `heapTotal` — V8 total heap size
  - `heapUsed` — V8 used heap size
  - `external` — memory used by C++ objects bound to JS objects (e.g., Buffers)
  - `arrayBuffers` — memory for ArrayBuffers and SharedArrayBuffers
- **No arguments, synchronous, never throws**
- **Formatting note:** Convert bytes to MB: `(bytes / 1024 / 1024).toFixed(2)`
- **Same gotcha:** This reports the MCP server process memory, not the bot's memory. For bot memory, pass `BOT_PID` env var and read `/proc/{pid}/status` on Linux, or just accept it reports the MCP server's own memory.

### `process.memoryUsage.rss()`
- Alternative: returns just the RSS as a number (slightly faster, avoids allocating the full object)
- Available since Node.js 15.6.0

---

## 3. SQLite Database Connectivity Check (better-sqlite3)

### How the codebase uses better-sqlite3
From `bot/src/db.ts`:
```ts
import Database from 'better-sqlite3';
this.db = new Database(dbPath);
this.db.pragma('journal_mode = WAL');
```

### Recommended Connectivity Check Options

**Option A: `SELECT 1` (fastest, minimal)**
```ts
const row = db.prepare('SELECT 1 AS ok').get() as { ok: number };
// Returns { ok: 1 } if database is working
```
- Proves: connection is open, query engine works
- Does NOT prove: tables exist, data is intact
- Execution time: sub-millisecond

**Option B: `PRAGMA quick_check` (lightweight integrity)**
```ts
const result = db.pragma('quick_check') as Array<{ quick_check: string }>;
// Returns [{ quick_check: 'ok' }] if database is healthy
// Returns error descriptions if corruption detected
```
- Proves: page-level integrity (no corruption in B-tree structure)
- Much faster than `PRAGMA integrity_check` (which also verifies indices)
- Can take seconds on large databases — use with caution
- **Recommendation: Use `SELECT 1` for health checks. Reserve `quick_check` for diagnostics.**

**Option C: `PRAGMA integrity_check` (full, slow)**
- DO NOT use for health checks. Can take minutes on large databases.

**Option D: Schema version check (proves migrations ran)**
```ts
const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get();
// Returns { value: '5' } for current schema
```
- Proves: database is open, tables exist, migrations completed
- This is the best middle ground for a health check

### Error Handling Patterns
From `bot/src/db.ts` — the codebase already wraps SQLite errors:
- `SQLITE_BUSY` / `SQLITE_LOCKED` — database locked by another process
- `ENOSPC` — disk full
- `SQLITE_CORRUPT` — database corrupted
- `EACCES` — permission denied

For the health check, wrap in try/catch:
```ts
try {
  const row = db.prepare('SELECT 1 AS ok').get();
  // also check schema version
  const version = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get();
  return { status: 'ok', schemaVersion: version?.value };
} catch (err) {
  return { status: 'error', error: getErrorMessage(err) };
}
```

### Gotcha: MCP Server Database Access
Each MCP server that needs the DB creates its own `DatabaseConnection` in `onInit()`. The health check server will need to do the same. Since SQLite WAL mode supports concurrent readers, this is safe. The health check just reads — no write conflicts.

---

## 4. Signal Client Connectivity Check

### How signal-cli is accessed
From `bot/src/signalClient.ts`, the bot uses JSON-RPC over HTTP:
```ts
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
```

### Recommended Health Check Approach
Use `listGroups` as the signal-cli already does for its readiness check (`waitForReady` uses `listGroups`):

```ts
async function checkSignalConnectivity(signalCliUrl: string, account: string): Promise<{ status: string; error?: string }> {
  try {
    const response = await fetch(`${signalCliUrl}/api/v1/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'listGroups',
        params: { account },
        id: `health-${Date.now()}`,
      }),
      signal: AbortSignal.timeout(5000), // 5s timeout for health check
    });

    if (!response.ok) {
      return { status: 'error', error: `HTTP ${response.status}: ${response.statusText}` };
    }

    const result = await response.json();
    if (result.error) {
      return { status: 'error', error: `RPC error: ${result.error.message}` };
    }

    return { status: 'ok' };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { status: 'error', error: 'Connection timed out (5s)' };
    }
    return { status: 'error', error: getErrorMessage(err) };
  }
}
```

### Non-blocking HTTP with Timeout
- **`AbortSignal.timeout(ms)`** — built into Node.js 18+. Creates an abort signal that triggers after `ms` milliseconds. No need for external libraries.
- The codebase already uses this pattern (see `signalClient.ts` line 41: `signal: AbortSignal.timeout(timeoutMs)`)
- On timeout, `fetch` throws a `DOMException` with `name === 'TimeoutError'` (Node.js 18+) or an `AbortError`
- **Recommended timeout for health checks: 5 seconds** (short enough to not block, long enough for a reasonable response)

### Edge Cases
- signal-cli may be restarting (connection refused) — catch `ECONNREFUSED`
- signal-cli may be overloaded (slow response) — timeout handles this
- Network issues — catch generic fetch errors
- **Do not call `receive`** for health checks — it dequeues messages and has side effects. `listGroups` is read-only and idempotent.

---

## 5. MCP Server Registry Status

### What to Report
From `bot/src/mcp/servers/index.ts` and `bot/src/mcp/registry.ts`:

```ts
import { ALL_SERVERS } from './servers/index';
```

`ALL_SERVERS` is a static array of `McpServerDefinition[]`. For a health check, report:
- Total number of registered servers
- List of server names and their tool counts
- Whether each server's entrypoint file exists on disk

### Implementation
```ts
import { ALL_SERVERS } from '../index'; // relative to servers/ directory
import fs from 'node:fs';
import path from 'node:path';

function getRegistryStatus() {
  const servers = ALL_SERVERS.map(s => {
    const tsPath = path.resolve(__dirname, `${s.entrypoint}.ts`);
    const jsPath = path.resolve(__dirname, `${s.entrypoint}.js`);
    const exists = fs.existsSync(tsPath) || fs.existsSync(jsPath);
    return {
      name: s.serverName,
      configKey: s.configKey,
      toolCount: s.tools.length,
      entrypointExists: exists,
    };
  });

  return {
    totalServers: servers.length,
    totalTools: servers.reduce((sum, s) => sum + s.toolCount, 0),
    servers,
  };
}
```

### Gotcha: Circular Import Risk
The health check server will be IN `ALL_SERVERS` (since it's registered in `index.ts`). When the health check server file imports from `../index`, it creates a circular dependency. Solutions:
1. **Don't import ALL_SERVERS at module level** — import it lazily inside the handler function
2. **Or read the registry info from env vars** passed by the bot process
3. **Recommended:** Just compute it in the handler. Node.js/TypeScript handles circular imports if the import happens after module initialization (i.e., inside a function call, not at top level).

---

## 6. Health Check Best Practices

### Standard Structure
Health checks typically return a structured response with:

```json
{
  "status": "healthy" | "degraded" | "unhealthy",
  "timestamp": "2026-03-07T12:00:00.000Z",
  "uptime": "2d 5h 30m 12s",
  "checks": {
    "database": { "status": "ok", "responseTimeMs": 1, "schemaVersion": "5" },
    "signalCli": { "status": "ok", "responseTimeMs": 45 },
    "mcpRegistry": { "status": "ok", "serverCount": 12, "toolCount": 37 },
    "memory": {
      "rss": "85.2 MB",
      "heapUsed": "42.1 MB",
      "heapTotal": "65.0 MB"
    }
  }
}
```

### Status Determination Logic
- **healthy:** All checks pass
- **degraded:** Some non-critical checks fail (e.g., signal-cli is temporarily unreachable but DB is fine)
- **unhealthy:** Critical checks fail (e.g., database is down)

### Key Principles
1. **Health checks should be fast** — use timeouts, avoid expensive operations
2. **Health checks should be side-effect free** — no writes, no message dequeuing
3. **Include timing** — measure how long each sub-check takes
4. **Include versions** — schema version, Node.js version
5. **No sensitive data** — don't expose connection strings, passwords, file paths

### Formatting for MCP Tool Output
Since this is an MCP tool (not an HTTP endpoint), the response goes back as text via `ok()`. Format as readable text, not raw JSON:

```
Bot Health Report
=================
Status: healthy
Timestamp: 2026-03-07 12:00:00 AEDT
Uptime: 2d 5h 30m 12s

Database: OK (1ms, schema v5)
Signal CLI: OK (45ms)
MCP Registry: 12 servers, 37 tools
Memory: RSS 85.2 MB, Heap 42.1/65.0 MB
```

---

## 7. Proposed Tool Definition

Single tool: `health_check` — no input parameters needed.

```ts
const TOOLS = [
  {
    name: 'health_check',
    title: 'Bot Health Check',
    description: 'Run a comprehensive health check on the bot. Reports uptime, database connectivity, Signal client status, MCP server registry, and memory usage.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
];
```

### Environment Variables Needed
```ts
envMapping: {
  DB_PATH: 'dbPath',
  SIGNAL_CLI_URL: 'signalCliUrl',
  SIGNAL_ACCOUNT: 'botPhoneNumber',
  BOT_START_TIME: ???  // NEW — needs to be added to AppConfig/MessageContext
}
```

### Open Question: Bot Uptime
`process.uptime()` in the MCP server process measures the MCP process lifetime (seconds since `npx tsx health.ts` started), not the bot's lifetime. Options:
1. **Pass `BOT_START_TIME` as env var** from the bot process — add to `AppConfig`, set in `index.ts` at startup, propagate via `envMapping`
2. **Use `process.uptime()` as-is** and label it "MCP server uptime" — simpler but less useful
3. **Read bot PID start time from `/proc`** — Linux-only, fragile

**Recommendation:** Option 1. Add `botStartTime: string` to `AppConfig` (set to `Date.now().toString()` at boot), pass as `BOT_START_TIME` env var.

---

## 8. Summary of Exact API Calls

| Component | API Call | Return Type | Notes |
|-----------|----------|-------------|-------|
| Uptime | `process.uptime()` | `number` (seconds) | MCP process only; use env var for bot uptime |
| Memory | `process.memoryUsage()` | `{ rss, heapTotal, heapUsed, external, arrayBuffers }` (all bytes) | Synchronous |
| DB check | `db.prepare('SELECT 1 AS ok').get()` | `{ ok: 1 } \| undefined` | Fastest option |
| DB schema | `db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get()` | `{ value: string } \| undefined` | Proves migrations ran |
| Signal check | `fetch(url, { signal: AbortSignal.timeout(5000) })` | `Promise<Response>` | Use `listGroups` method |
| Registry | `ALL_SERVERS.length`, `.map(s => s.tools.length)` | static array | Import lazily to avoid circular deps |

---

## 9. File Paths Relevant to Implementation

- **MCP types:** `/home/zknowles/personal/signal-bot/bot/src/mcp/types.ts`
- **Result helpers:** `/home/zknowles/personal/signal-bot/bot/src/mcp/result.ts`
- **Validation helpers:** `/home/zknowles/personal/signal-bot/bot/src/mcp/validate.ts`
- **Env helpers:** `/home/zknowles/personal/signal-bot/bot/src/mcp/env.ts`
- **Run server:** `/home/zknowles/personal/signal-bot/bot/src/mcp/runServer.ts`
- **Server registry barrel:** `/home/zknowles/personal/signal-bot/bot/src/mcp/servers/index.ts`
- **Registry builder:** `/home/zknowles/personal/signal-bot/bot/src/mcp/registry.ts`
- **Database connection:** `/home/zknowles/personal/signal-bot/bot/src/db.ts`
- **Signal client (fetch pattern):** `/home/zknowles/personal/signal-bot/bot/src/signalClient.ts`
- **Config/AppConfig types:** `/home/zknowles/personal/signal-bot/bot/src/config.ts`, `/home/zknowles/personal/signal-bot/bot/src/types.ts`
- **Example simple server (signal):** `/home/zknowles/personal/signal-bot/bot/src/mcp/servers/signal.ts`
- **Example complex server (darkFactory):** `/home/zknowles/personal/signal-bot/bot/src/mcp/servers/darkFactory.ts`
