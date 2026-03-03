---
name: creating-mcp-tools
description: Use when creating, adding, or modifying MCP tool servers for the signal bot — covers any language (TypeScript, Rust, Python, bash), enforces TDD, and protects core bot code from runtime modifications.
---

# Creating MCP Tools

## Overview

MCP tools in this project are **standalone stdio JSON-RPC 2.0 servers** spawned by Claude CLI as subprocesses. They are **language-agnostic** — any executable that reads JSON-RPC from stdin and writes responses to stdout works. The bot can add/remove MCP servers **at runtime without restarting** because each is an independent process.

## Safety Rules

**NEVER modify while bot is running:**
- `bot/src/index.ts` — main loop
- `bot/src/messageHandler.ts` — message dispatch
- `bot/src/signalClient.ts` — Signal protocol
- `bot/src/config.ts` — env config
- `bot/src/reminderScheduler.ts` — reminder polling

**Safe to modify anytime (independent processes):**
- Any `*McpServer.ts` file in `bot/src/`
- `bot/src/storage.ts` (only if tool needs persistence)
- `bot/src/claudeClient.ts` (registration — but only when bot is stopped or between restarts)

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
    proc = spawnServer('<name>McpServer.ts', env);
    return proc;
  }

  // Required tests: initialize, tools/list, unknown tool, unknown method, per-tool validation, per-tool success
});
```

**Required test coverage:**
1. `initialize` returns valid protocol response
2. `tools/list` returns correct tool count and names
3. Unknown tool returns `isError: true`
4. Unknown method returns JSON-RPC `-32601` error
5. Per-tool: missing/invalid parameter validation
6. Per-tool: successful execution with expected output

### Step 2: Watch tests fail (RED)

```bash
cd bot && npx vitest run tests/<name>McpServer.test.ts
```

All tests must fail. If any pass, your tests are wrong.

### Step 3: Write server `bot/src/<name>McpServer.ts`

**MUST use `mcpServerBase.ts`** — do NOT duplicate protocol boilerplate.

Import `getErrorMessage` when your tool has external I/O (API calls, file ops, subprocess). Pure-computation tools can omit it:

```typescript
import { getErrorMessage, runMcpServer, type ToolResult } from './mcpServerBase';

const TOOLS = [
  {
    name: 'tool_name',
    title: 'Tool Title',
    description: 'What this tool does.',
    inputSchema: {
      type: 'object' as const,
      properties: { /* ... */ },
      required: ['param1'],
    },
  },
];

function handleToolCall(name: string, args: Record<string, unknown>): ToolResult {
  switch (name) {
    case 'tool_name':
      return handleToolName(args);
    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
}

runMcpServer({
  name: 'signal-bot-<name>',
  tools: TOOLS,
  handleToolCall,
  onInit() { console.error('<Name> MCP server started'); },
});
```

### Step 4: Watch tests pass (GREEN)

```bash
cd bot && npx vitest run tests/<name>McpServer.test.ts
```

### Step 5: Register in `bot/src/claudeClient.ts`

Two changes needed (do this when bot is stopped):

1. Add tool names to `MCP_TOOLS` array (format: `mcp__<serverKey>__<toolName>`)
2. Add server entry to `mcpServers` in `generateResponse()`:

```typescript
const myServer = resolveMcpServerPath('<name>McpServer');
// In mcpServers object:
<serverKey>: {
  command: myServer.command,
  args: myServer.args,
  env: { /* any env vars the server needs */ },
},
```

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

**Registration in claudeClient.ts** is the same — just point `command`/`args` at the binary:
```typescript
myTool: {
  command: '/path/to/my-rust-binary',
  args: [],
  env: { SOME_VAR: 'value' },
},
```

**Testing** uses the same `mcpTestHelpers.ts` pattern but with a custom spawn:
```typescript
function spawnMcpServer(): ChildProcess {
  proc = spawn('/path/to/binary', [], { stdio: ['pipe', 'pipe', 'pipe'] });
  return proc;
}
```

## Key File References

| File | Purpose |
|------|---------|
| `bot/src/mcpServerBase.ts` | Shared TS framework: `runMcpServer()`, `ToolResult`, `getErrorMessage()` |
| `bot/src/claudeClient.ts` | Registration: `MCP_TOOLS` string + `mcpServers` config object |
| `bot/tests/helpers/mcpTestHelpers.ts` | Shared test helpers: `spawnMcpServer()`, `sendAndReceive()`, `initializeServer()` |

## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "It's too simple to need tests first" | Simple tools still need protocol tests. Write them first. |
| "I'll write tests after the code" | Tests-after prove what code does, not what it should do. |
| "I know this pattern, I'll just copy-paste the boilerplate" | That's exactly what `runMcpServer()` eliminates. Import it. |
| "The shared helpers don't fit my case" | They work for TS and non-TS servers. Customize `spawnMcpServer`, reuse the rest. |
| "I need to modify messageHandler.ts for my new tool" | No. MCP tools are discovered via `tools/list`. No core changes needed. |

## Red Flags — STOP and Start Over

- Writing server code before test file exists
- Copying `readline`/`handleMessage`/`main()` boilerplate instead of using `runMcpServer()`
- Defining local `ToolResult` type instead of importing from `mcpServerBase`
- Defining local `PROTOCOL_VERSION` instead of using `MCP_PROTOCOL_VERSION`
- Writing your own `sendAndReceive`/`initializeServer` in tests instead of importing shared helpers
- Modifying core files (index.ts, messageHandler.ts) for a new tool
- Skipping `npx vitest run` or `npm run check` before declaring done
