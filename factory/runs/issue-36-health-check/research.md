# Research — issue-36-health-check

## Codebase Analysis

### MCP Server Pattern
- Export `McpServerDefinition` with: `serverName`, `configKey`, `entrypoint` (filename only), `tools`, `envMapping`, `handlers`, `onInit()`, `onClose()`
- Use shared helpers: `ok()`, `error()`, `catchErrors()` from `result.ts`; `requireString()`, etc. from `validate.ts`; `readStorageEnv()` from `env.ts`
- Module-level state initialized in `onInit()`, closed in `onClose()`
- Standalone entry: `if (require.main === module) runServer(server)`
- Register by adding one import to `bot/src/mcp/servers/index.ts` → `ALL_SERVERS` array

### Database Access
- `DatabaseConnection` wraps better-sqlite3 with WAL mode
- Access via `conn.db.prepare('SELECT 1').get()` for liveness check
- Can also check `schema_meta` table for schema version (currently v5)
- `PRAGMA quick_check` too slow for routine health checks

### Signal Client Connectivity
- Use `fetch()` with `AbortSignal.timeout(5000)` to JSON-RPC endpoint
- Call `listGroups` method (read-only, idempotent) — same as `SignalClient.waitForReady()`
- Needs `SIGNAL_CLI_URL` and `SIGNAL_ACCOUNT` (bot phone number)
- Must handle unreachable gracefully (catch fetch errors)

### Bot Uptime
- No existing uptime tracking in codebase
- `process.uptime()` measures MCP server process uptime (not bot)
- Option: pass `BOT_START_TIME` env var from main bot process via envMapping
- Simpler option: just use `process.uptime()` since MCP server lifetime ≈ invocation scope

### Memory Usage
- `process.memoryUsage()` returns `{ rss, heapTotal, heapUsed, external, arrayBuffers }` in bytes
- Reports MCP server process memory, not main bot process

### MCP Registry Status
- `ALL_SERVERS` array in `bot/src/mcp/servers/index.ts`
- Can count servers and tools at import time
- Caveat: health check server will be in the array (self-referencing is fine, just count)

### Env Mapping Needed
```typescript
envMapping: {
  DB_PATH: 'dbPath',
  SIGNAL_CLI_URL: 'signalCliUrl',
  SIGNAL_ACCOUNT: 'botPhoneNumber',
}
```

## Prior Art Review

### No Conflicts Found
- No existing health check/monitoring code
- No naming conflicts (`healthCheck` is new)
- No blocking dependencies on other issues
- Dark factory (#34) and GitHub PR tools (#35) recently merged — provide exact pattern to follow

### Existing Health-Adjacent Code
- `SignalClient.waitForReady()` — retries `listGroups` with exponential backoff
- `DatabaseConnection` — WAL mode, error wrapping, migrations
- Message polling heartbeat in `index.ts` (every 30 polls)

### Current Registered Servers (11)
darkFactory, github, reminder, dossier, images, memory, messageHistory, weather, sourceCode, signal, persona

## Docs Research

### better-sqlite3
- `db.prepare('SELECT 1 AS ok').get()` — fast liveness check
- Synchronous API, no async needed for DB checks

### Node.js Process API
- `process.uptime()` — seconds as float
- `process.memoryUsage()` — bytes for rss, heapTotal, heapUsed, external, arrayBuffers

### Signal-cli JSON-RPC
- POST to `{url}/api/v1/rpc` with JSON-RPC body
- `listGroups` is lightweight, read-only, safe for health checks
- Use `AbortSignal.timeout(5000)` to prevent hanging

## Key Risks
1. **Process isolation**: MCP server runs as subprocess — uptime/memory reflect that process, not main bot
2. **DB locking**: Read-only `SELECT 1` minimizes impact
3. **Signal-cli timeout**: Must use AbortSignal to prevent hanging health checks
4. **No group context needed**: Health check is global, don't use `requireGroupId()`
