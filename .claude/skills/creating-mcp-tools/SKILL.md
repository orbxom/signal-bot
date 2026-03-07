---
name: creating-mcp-tools
description: Use when creating, adding, or modifying MCP tool servers for the signal bot — covers any language (TypeScript, Rust, Python, bash), enforces TDD, and protects core bot code from runtime modifications.
---

# Creating MCP Tools

## Overview

MCP tools in this project are **standalone stdio JSON-RPC 2.0 servers** spawned by Claude CLI as subprocesses. They are **language-agnostic** — any executable that reads JSON-RPC from stdin and writes responses to stdout works. The bot auto-discovers servers from a registry — adding a new server requires **no changes to core bot files**.

## Safety Rules

**NEVER modify while bot is running:**
- `bot/src/index.ts` — main loop
- `bot/src/messageHandler.ts` — message dispatch
- `bot/src/signalClient.ts` — Signal protocol
- `bot/src/config.ts` — env config
- `bot/src/reminderScheduler.ts` — reminder polling

**Safe to modify anytime (independent processes):**
- Any file in `bot/src/mcp/servers/`
- `bot/src/mcp/` framework files (types, result, validate, env)
- `bot/src/stores/` (if tool needs persistence)

## TDD Requirements — Tests FIRST

```
Write test file FIRST → Watch it FAIL → Write server code → Watch it PASS → Register
```

Write code before tests? **Delete it. Start over.**

No exceptions:
- Not for "simple tools"
- Not for "I'll add tests after"
- Not for "I already know what the code looks like"

## Creating a TypeScript MCP Tool

### Step 1: Write test file `bot/tests/<name>McpServer.test.ts`

Use shared helpers — do NOT rewrite `sendAndReceive`/`initializeServer`:

```typescript
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { initializeServer, sendAndReceive, spawnMcpServer as spawnServer } from './helpers/mcpTestHelpers';

describe('<Name> MCP Server', () => {
  let proc: ChildProcess | null = null;
  afterEach(() => { proc?.kill(); proc = null; });

  function spawnMcpServer(env?: Record<string, string>): ChildProcess {
    proc = spawnServer('mcp/servers/<name>.ts', env);
    return proc;
  }

  // Required tests: initialize, tools/list, unknown tool, per-tool validation, per-tool success
});
```

**Required test coverage:**
1. `initialize` returns valid protocol response with correct `serverInfo.name`
2. `tools/list` returns correct tool count and names
3. Unknown tool returns `isError: true` with "Unknown tool" message
4. Per-tool: missing/invalid parameter validation returns `isError: true`
5. Per-tool: successful execution with expected output

**For DB-backed servers**, use temp directories:
```typescript
let testDir: string;
beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), '<name>-mcp-test-'));
  // Pre-populate DB if needed
});
afterEach(() => rmSync(testDir, { recursive: true, force: true }));
```

### Step 2: Watch tests fail (RED)

```bash
cd bot && npx vitest run tests/<name>McpServer.test.ts
```

All tests must fail. If any pass, your tests are wrong.

### Step 3: Write server `bot/src/mcp/servers/<name>.ts`

Export a `McpServerDefinition` using the shared framework. **Never** duplicate protocol boilerplate — `runServer()` handles all JSON-RPC plumbing.

```typescript
import { readStorageEnv } from '../env';
import { catchErrors, error, ok } from '../result';
import { runServer } from '../runServer';
import type { McpServerDefinition, ToolResult } from '../types';
import { requireString } from '../validate';

// Module-level state initialized in onInit()
let someState: SomeType | null = null;

const TOOLS = [
  {
    name: 'tool_name',
    title: 'Tool Title',
    description: 'What this tool does.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        param1: { type: 'string', description: 'Description of param1' },
      },
      required: ['param1'],
    },
  },
];

export const myServer: McpServerDefinition = {
  serverName: 'signal-bot-<name>',
  configKey: '<name>',
  entrypoint: '<name>',
  tools: TOOLS,
  envMapping: { DB_PATH: 'dbPath', MCP_GROUP_ID: 'groupId' },
  handlers: {
    tool_name(args): ToolResult {
      const param = requireString(args, 'param1');
      if (param.error) return param.error;
      return catchErrors(() => {
        // Tool logic here
        return ok('Result text');
      }, 'Failed to do thing');
    },
  },
  onInit() {
    const env = readStorageEnv();
    // Initialize state from env
    console.error('<Name> MCP server started');
  },
  onClose() {
    // Clean up resources
  },
};

if (require.main === module) {
  runServer(myServer);
}
```

**Key interfaces:**

| Type | From | Purpose |
|------|------|---------|
| `McpServerDefinition` | `../types` | Server definition with tools, handlers, env mapping |
| `ToolResult` | `../types` | Return type: `{ content: ToolResultContent[], isError?: boolean }` |
| `ToolHandler` | `../types` | `(args) => ToolResult \| Promise<ToolResult>` |
| `ok(text)` | `../result` | Success result shorthand |
| `error(text)` | `../result` | Error result with `isError: true` |
| `catchErrors(fn, prefix?)` | `../result` | Wraps sync/async in try-catch returning error results |
| `requireString(args, name)` | `../validate` | Returns `{ value }` or `{ error }` — check `.error` first |
| `requireNumber(args, name)` | `../validate` | Same pattern for numbers |
| `optionalString(args, name, default)` | `../validate` | Returns string value or default |
| `requireGroupId(groupId)` | `../validate` | Returns error ToolResult or null |
| `readStorageEnv()` | `../env` | Returns `{ dbPath, groupId, sender }` from env vars |
| `readTimezone()` | `../env` | Returns timezone string (default: `Australia/Sydney`) |

**STDIO logging rule:** Never use `console.log()` — it writes to stdout and corrupts JSON-RPC. Use `console.error()` for all logging.

### Step 4: Watch tests pass (GREEN)

```bash
cd bot && npx vitest run tests/<name>McpServer.test.ts
```

### Step 5: Register in barrel export

Add one import line to `bot/src/mcp/servers/index.ts`:

```typescript
import { myServer } from './<name>';

export const ALL_SERVERS: McpServerDefinition[] = [
  // ... existing servers ...
  myServer,
];
```

That's it. The registry auto-discovers tools and builds the MCP config. No other files need to change.

### Step 6: Verify everything

```bash
cd bot && npx vitest run && npm run check
```

## Creating a Non-TypeScript MCP Tool

Any executable that speaks JSON-RPC 2.0 over stdio works. Protocol requirements:

**Input:** One JSON object per line on stdin
**Output:** One JSON object per line on stdout
**Stderr:** Logging only (not read by client)

**Required methods:**
- `initialize` → respond with `{ protocolVersion, capabilities: { tools: {} }, serverInfo: { name, version } }`
- `notifications/initialized` → no response (notification)
- `tools/list` → respond with `{ tools: [...] }`
- `tools/call` → respond with `{ content: [{ type: 'text', text: '...' }], isError?: true }`
- Unknown method with `id` → respond with `{ error: { code: -32601, message: '...' } }`

**Registration** for non-TS servers uses the `EXTERNAL_SERVERS` object in `bot/src/mcp/registry.ts`:
```typescript
const EXTERNAL_SERVERS = {
  myTool: {
    tools: ['mcp__myTool__tool_name'],
    resolve(context: MessageContext) {
      return {
        command: '/path/to/binary',
        args: [],
        env: { SOME_VAR: context.someField || '' },
      };
    },
  },
};
```

**Testing** uses the same `mcpTestHelpers.ts` but with a custom spawn:
```typescript
function spawnMcpServer(): ChildProcess {
  proc = spawn('/path/to/binary', [], { stdio: ['pipe', 'pipe', 'pipe'] });
  return proc;
}
```

## Key File References

| File | Purpose |
|------|---------|
| `bot/src/mcp/types.ts` | `McpServerDefinition`, `ToolDefinition`, `ToolHandler`, `ToolResult` |
| `bot/src/mcp/result.ts` | `ok()`, `error()`, `catchErrors()`, `getErrorMessage()`, `estimateTokens()` |
| `bot/src/mcp/validate.ts` | `requireString()`, `requireNumber()`, `requireGroupId()`, `optionalString()` |
| `bot/src/mcp/env.ts` | `readStorageEnv()`, `readTimezone()` |
| `bot/src/mcp/runServer.ts` | `runServer()` — JSON-RPC protocol handler (stdin/stdout) |
| `bot/src/mcp/registry.ts` | `buildAllowedTools()`, `buildMcpConfig()` — auto-discovers from `ALL_SERVERS` |
| `bot/src/mcp/servers/index.ts` | Barrel export: `ALL_SERVERS` array (add one import here) |
| `bot/tests/helpers/mcpTestHelpers.ts` | `spawnMcpServer()`, `sendAndReceive()`, `initializeServer()` |

## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "It's too simple to need tests first" | Simple tools still need protocol tests. Write them first. |
| "I'll write tests after the code" | Tests-after prove what code does, not what it should do. |
| "I'll just copy-paste from another server" | Good — but write the test first, then adapt from an existing server. |
| "The shared helpers don't fit my case" | They work for TS and non-TS servers. Customize `spawnMcpServer`, reuse the rest. |
| "I need to modify messageHandler.ts for my new tool" | No. MCP tools are auto-discovered via the registry. No core changes needed. |
| "I need to update claudeClient.ts" | No. Add to `servers/index.ts` barrel. Registry handles the rest. |

## Red Flags — STOP and Start Over

- Writing server code before test file exists
- Duplicating JSON-RPC protocol handling instead of using `runServer()`
- Defining local `ToolResult` type instead of importing from `mcp/types`
- Writing your own `sendAndReceive`/`initializeServer` instead of importing shared helpers
- Modifying core files (index.ts, messageHandler.ts, claudeClient.ts) for a new tool
- Using `console.log()` instead of `console.error()` for logging
- Skipping `npx vitest run` or `npm run check` before declaring done
