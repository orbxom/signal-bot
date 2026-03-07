# Health Check MCP Server Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `health_check` MCP tool that returns structured JSON with bot uptime, database connectivity, signal-cli reachability, MCP registry status, and memory usage.

**Architecture:** Single MCP server (`healthCheck.ts`) with one tool (`health_check`). Follows standard `McpServerDefinition` pattern. Checks DB via raw `better-sqlite3` in read-only mode (avoids migrations), signal-cli via `listGroups` JSON-RPC with 3s timeout (parsing response to differentiate connection errors from RPC errors), reports bot uptime via `BOT_START_TIME` env var, MCP registry via `ALL_SERVERS` count, and `process.memoryUsage()`. Returns overall status as "healthy", "degraded", or "unhealthy".

**Tech Stack:** TypeScript, better-sqlite3 (raw, read-only), Node.js fetch API, MCP JSON-RPC protocol

---

### Task 1: Scaffold health check server and register it

**Files:**
- Create: `bot/src/mcp/servers/healthCheck.ts`
- Modify: `bot/src/mcp/servers/index.ts`

**Step 1: Create minimal server definition**

Create `bot/src/mcp/servers/healthCheck.ts` with a stub `health_check` tool that returns a placeholder response:

```typescript
import type { McpServerDefinition } from '../types';
import { runServer } from '../runServer';
import { ok } from '../result';

const TOOLS = [
  {
    name: 'health_check',
    title: 'Health Check',
    description:
      'Returns a health status report including bot uptime, database connectivity, signal-cli reachability, MCP registry status, and process memory usage. Note: memory values reflect the MCP server subprocess, not the main bot process.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
];

export const healthCheckServer: McpServerDefinition = {
  serverName: 'signal-bot-health-check',
  configKey: 'healthCheck',
  entrypoint: 'healthCheck',
  tools: TOOLS,
  envMapping: {
    DB_PATH: 'dbPath',
    SIGNAL_CLI_URL: 'signalCliUrl',
    SIGNAL_ACCOUNT: 'botPhoneNumber',
    BOT_START_TIME: 'botStartTime',
  },
  handlers: {
    health_check() {
      return ok(JSON.stringify({ status: 'healthy' }));
    },
  },
  onInit() {},
  onClose() {},
};

if (require.main === module) {
  runServer(healthCheckServer);
}
```

**Step 2: Register in barrel**

Add import to `bot/src/mcp/servers/index.ts`:

```typescript
import { healthCheckServer } from './healthCheck';
```

Add `healthCheckServer` to the `ALL_SERVERS` array (alphabetical order among existing entries).

**Step 3: Add `botStartTime` to AppConfig/MessageContext**

In `bot/src/config.ts`, add `botStartTime` to the config type and set it to `Date.now().toString()` at startup. In `bot/src/types.ts`, add `botStartTime` to the `MessageContext` type so the registry can map it to `BOT_START_TIME` env var.

**Step 4: Run lint to verify no errors**

Run: `cd bot && npm run check`
Expected: PASS

**Step 5: Commit**

```bash
git add bot/src/mcp/servers/healthCheck.ts bot/src/mcp/servers/index.ts bot/src/config.ts bot/src/types.ts
git commit -m "feat: scaffold health check MCP server with botStartTime config"
```

---

### Task 2: Test and implement the full health_check tool

**Files:**
- Create: `bot/tests/healthCheckMcpServer.test.ts`
- Modify: `bot/src/mcp/servers/healthCheck.ts`

**Reference:** Look at `bot/tests/reminderMcpServer.test.ts` or `bot/tests/darkFactoryMcpServer.test.ts` for the test pattern — they use `spawnMcpServer()`, `initializeServer()`, `sendAndReceive()` from `bot/tests/helpers/mcpTestHelpers.ts`.

**Step 1: Write failing test — health_check returns structured response**

Create `bot/tests/healthCheckMcpServer.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChildProcess } from 'node:child_process';
import {
  spawnMcpServer,
  initializeServer,
  sendAndReceive,
} from './helpers/mcpTestHelpers';
import { DatabaseConnection } from '../src/db';

describe('Health Check MCP Server', () => {
  let testDir: string;
  let dbPath: string;
  let proc: ChildProcess;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'health-check-test-'));
    dbPath = join(testDir, 'test.db');
    // Initialize a real database so DB check passes
    const db = new DatabaseConnection(dbPath);
    db.close();
  });

  afterEach(() => {
    if (proc) proc.kill();
    if (testDir) rmSync(testDir, { recursive: true, force: true });
  });

  function spawnServer(env: Record<string, string> = {}) {
    proc = spawnMcpServer('mcp/servers/healthCheck.ts', {
      DB_PATH: dbPath,
      SIGNAL_CLI_URL: 'http://localhost:19999', // intentionally wrong port
      SIGNAL_ACCOUNT: '+61400000000',
      BOT_START_TIME: (Date.now() - 60000).toString(), // 1 minute ago
      ...env,
    });
    return proc;
  }

  it('should list the health_check tool', async () => {
    const server = spawnServer();
    await initializeServer(server);

    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    });

    const tools = response.result.tools;
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('health_check');
  });

  it('should return structured health status with database ok', async () => {
    const server = spawnServer();
    await initializeServer(server);

    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'health_check', arguments: {} },
    });

    const text = response.result.content[0].text;
    const health = JSON.parse(text);

    expect(health.status).toBeDefined();
    expect(health.database.status).toBe('ok');
    expect(health.uptime).toBeGreaterThanOrEqual(60); // at least 60s from BOT_START_TIME
    expect(health.memory.heapUsed).toBeGreaterThan(0);
    expect(health.memory.rss).toBeGreaterThan(0);
    expect(health.mcp.registeredServers).toBeGreaterThan(0);
    expect(health.mcp.registeredTools).toBeGreaterThan(0);
    expect(health.timestamp).toBeDefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd bot && npx vitest run tests/healthCheckMcpServer.test.ts`
Expected: FAIL (stub returns `{ status: 'healthy' }` without other fields)

**Step 3: Implement the full handler**

Update `bot/src/mcp/servers/healthCheck.ts`:

```typescript
import Database from 'better-sqlite3';
import type { McpServerDefinition } from '../types';
import { runServer } from '../runServer';
import { ok, error, catchErrors, getErrorMessage } from '../result';
import { ALL_SERVERS } from './index';

const TOOLS = [
  {
    name: 'health_check',
    title: 'Health Check',
    description:
      'Returns a health status report including bot uptime, database connectivity, signal-cli reachability, MCP registry status, and process memory usage. Note: memory values reflect the MCP server subprocess, not the main bot process.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
];

let db: Database.Database | null = null;
let signalCliUrl = '';
let signalAccount = '';
let botStartTime = 0;

function checkDatabase(): { status: string; error?: string } {
  if (!db) return { status: 'error', error: 'Database not initialized' };
  try {
    db.prepare('SELECT 1 AS ok').get();
    return { status: 'ok' };
  } catch (err) {
    return { status: 'error', error: getErrorMessage(err) };
  }
}

async function checkSignal(): Promise<{ status: string; error?: string }> {
  if (!signalCliUrl) {
    return { status: 'unreachable', error: 'SIGNAL_CLI_URL not configured' };
  }
  try {
    const response = await fetch(`${signalCliUrl}/api/v1/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'listGroups',
        params: { account: signalAccount },
        id: 'health-check',
      }),
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) {
      return { status: 'error', error: `HTTP ${response.status}` };
    }
    const result = (await response.json()) as { error?: { message: string } };
    if (result.error) {
      return { status: 'error', error: `RPC error: ${result.error.message}` };
    }
    return { status: 'ok' };
  } catch (err) {
    return { status: 'unreachable', error: getErrorMessage(err) };
  }
}

function getMemory() {
  const mem = process.memoryUsage();
  return {
    heapUsed: mem.heapUsed,
    heapTotal: mem.heapTotal,
    rss: mem.rss,
    external: mem.external,
  };
}

function getMcpRegistry() {
  return {
    registeredServers: ALL_SERVERS.length,
    registeredTools: ALL_SERVERS.reduce((sum, s) => sum + s.tools.length, 0),
  };
}

function getUptime(): number {
  if (botStartTime > 0) {
    return (Date.now() - botStartTime) / 1000;
  }
  return process.uptime();
}

function getOverallStatus(db: { status: string }, signal: { status: string }): string {
  if (db.status === 'ok' && signal.status === 'ok') return 'healthy';
  if (db.status !== 'ok') return 'unhealthy';
  return 'degraded';
}

export const healthCheckServer: McpServerDefinition = {
  serverName: 'signal-bot-health-check',
  configKey: 'healthCheck',
  entrypoint: 'healthCheck',
  tools: TOOLS,
  envMapping: {
    DB_PATH: 'dbPath',
    SIGNAL_CLI_URL: 'signalCliUrl',
    SIGNAL_ACCOUNT: 'botPhoneNumber',
    BOT_START_TIME: 'botStartTime',
  },
  handlers: {
    health_check() {
      return catchErrors(async () => {
        const database = checkDatabase();
        const signal = await checkSignal();
        const memory = getMemory();
        const uptime = getUptime();
        const mcp = getMcpRegistry();
        const status = getOverallStatus(database, signal);

        return ok(
          JSON.stringify({
            status,
            uptime,
            database,
            signal,
            mcp,
            memory,
            timestamp: new Date().toISOString(),
          })
        );
      }, 'Health check failed');
    },
  },
  onInit() {
    const dbPath = process.env.DB_PATH;
    if (dbPath) {
      try {
        db = new Database(dbPath, { readonly: true });
      } catch (err) {
        console.error('Health check: failed to open database:', err);
      }
    }
    signalCliUrl = process.env.SIGNAL_CLI_URL || '';
    signalAccount = process.env.SIGNAL_ACCOUNT || '';
    botStartTime = parseInt(process.env.BOT_START_TIME || '0', 10) || 0;
  },
  onClose() {
    if (db) {
      db.close();
      db = null;
    }
  },
};

if (require.main === module) {
  runServer(healthCheckServer);
}
```

Key changes from the original plan:
- Uses raw `better-sqlite3` Database in read-only mode instead of DatabaseConnection (avoids running migrations — review #6)
- Adds `BOT_START_TIME` env var for accurate bot uptime (review #1)
- Adds MCP registry status via `ALL_SERVERS` count (review #2)
- Parses signal-cli JSON-RPC response to differentiate connection errors from RPC errors (review #3)
- Reduces timeout to 3s (review #4)
- Wraps handler in `catchErrors()` (review #12)
- Logs actual error on DB init failure (review #13)

**Step 4: Run test to verify it passes**

Run: `cd bot && npx vitest run tests/healthCheckMcpServer.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add bot/tests/healthCheckMcpServer.test.ts bot/src/mcp/servers/healthCheck.ts
git commit -m "feat: implement health_check tool with db, signal, uptime, memory, registry checks"
```

---

### Task 3: Test signal-cli and database failure scenarios

**Files:**
- Modify: `bot/tests/healthCheckMcpServer.test.ts`

**Step 1: Add failure scenario tests**

Add to the test file:

```typescript
it('should return degraded status when signal-cli is unreachable', async () => {
  const server = spawnServer({
    SIGNAL_CLI_URL: 'http://localhost:19999', // nothing listening
  });
  await initializeServer(server);

  const response = await sendAndReceive(server, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'health_check', arguments: {} },
  });

  const text = response.result.content[0].text;
  const health = JSON.parse(text);

  expect(health.status).toBe('degraded');
  expect(health.database.status).toBe('ok');
  expect(health.signal.status).toBe('unreachable');
  expect(health.signal.error).toBeDefined();
});

it('should return degraded when SIGNAL_CLI_URL is not configured', async () => {
  const server = spawnServer({ SIGNAL_CLI_URL: '' });
  await initializeServer(server);

  const response = await sendAndReceive(server, {
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'health_check', arguments: {} },
  });

  const text = response.result.content[0].text;
  const health = JSON.parse(text);

  expect(health.status).toBe('degraded');
  expect(health.signal.status).toBe('unreachable');
  expect(health.signal.error).toContain('not configured');
});

it('should return unhealthy when database path is invalid', async () => {
  const server = spawnServer({
    DB_PATH: '/nonexistent/path/db.sqlite',
  });
  await initializeServer(server);

  const response = await sendAndReceive(server, {
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'health_check', arguments: {} },
  });

  const text = response.result.content[0].text;
  const health = JSON.parse(text);

  expect(health.status).toBe('unhealthy');
  expect(health.database.status).toBe('error');
  expect(health.database.error).toBeDefined();
});

it('should return unhealthy when both DB and signal are down', async () => {
  const server = spawnServer({
    DB_PATH: '/nonexistent/path/db.sqlite',
    SIGNAL_CLI_URL: 'http://localhost:19999',
  });
  await initializeServer(server);

  const response = await sendAndReceive(server, {
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: { name: 'health_check', arguments: {} },
  });

  const text = response.result.content[0].text;
  const health = JSON.parse(text);

  expect(health.status).toBe('unhealthy');
  expect(health.database.status).toBe('error');
  expect(health.signal.status).toBe('unreachable');
});
```

**Step 2: Run tests**

Run: `cd bot && npx vitest run tests/healthCheckMcpServer.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add bot/tests/healthCheckMcpServer.test.ts
git commit -m "test: add failure scenarios for health check (signal down, db down, both down)"
```

---

### Task 4: Run full test suite and lint

**Step 1: Run all tests**

Run: `cd bot && npx vitest run`
Expected: All tests pass, including the new health check tests

**Step 2: Run lint and format check**

Run: `cd bot && npm run check`
Expected: PASS

**Step 3: Fix any issues found**

If lint/format issues, fix them and re-run.

**Step 4: Final commit if needed**

```bash
git add -A
git commit -m "chore: fix lint issues"
```

---

## Revisions

### Changes from devil's advocate review:

| Concern | Resolution |
|---------|------------|
| #1 (High) Misleading uptime/memory | Added `BOT_START_TIME` env var for accurate bot uptime. Memory labeled as subprocess-level in tool description. |
| #2 (High) Missing MCP registry | Added `mcp` field with `registeredServers`/`registeredTools` from `ALL_SERVERS`. |
| #3 (Medium) Signal response not parsed | Now parses JSON-RPC response to differentiate connection refused vs RPC error. |
| #4 (Low) 5s timeout too long | Reduced to 3s. |
| #5 (Low) Overall status value | Kept — useful for quick assessment, low cost. |
| #6 (Medium) Heavyweight DB init | Changed to raw `better-sqlite3` Database in read-only mode, no migrations. |
| #7 (Low) No both-down test | Added test case. |
| #8 (Low) Test file location | Follows existing convention (correct choice). |
| #9 (Low) No input params | YAGNI — dismissed. |
| #10 (Low) No rate limiting | Not needed — dismissed. |
| #11 (Low) envMapping chain | Not a problem — dismissed. |
| #12 (Low) No catchErrors | Added `catchErrors()` wrapper. |
| #13 (Medium) Swallowed error | Now logs actual error message. |
