# Dark Factory MCP Server Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add two MCP tools (`start_dark_factory`, `read_dark_factory`) so Signal users can launch and monitor dark-factory autonomous development sessions.

**Architecture:** New MCP server `darkFactory.ts` with two tools, gated behind `DARK_FACTORY_ENABLED` env var. `start_dark_factory` writes a temporary zellij KDL layout file, then launches `kitty @ launch` with that layout to open a terminal running Claude interactively. `read_dark_factory` finds the correct JSONL file by matching the issue number in user messages, then parses it for progress. Session metadata stored in `factory/sessions/`.

**Tech Stack:** Node.js child_process, kitty remote control, zellij layouts (KDL), Claude JSONL conversation files.

## Revisions (from devil's advocate review)
1. **Fixed path encoding bug** — `projectRoot().replace(/\//g, '-')` (leading `/` becomes `-` naturally, no extra prefix)
2. **Improved JSONL correlation** — match by issue number in user messages, not just mtime
3. **Added env var gate** — `DARK_FACTORY_ENABLED` must be set to use tools
4. **Worktree concern dismissed** — main Claude session runs from project root; subagent JSONLs are nested under main session

---

### Task 1: Scaffold MCP Server with Input Validation Tests

**Files:**
- Create: `bot/tests/darkFactoryMcpServer.test.ts`
- Create: `bot/src/mcp/servers/darkFactory.ts`

**Step 1: Write the failing tests**

```typescript
// bot/tests/darkFactoryMcpServer.test.ts
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { initializeServer, sendAndReceive, spawnMcpServer as spawnServer } from './helpers/mcpTestHelpers';

describe('Dark Factory MCP Server', () => {
  let proc: ChildProcess | null = null;

  afterEach(() => {
    if (proc) {
      proc.kill();
      proc = null;
    }
  });

  function spawnMcpServer(env?: Record<string, string>): ChildProcess {
    proc = spawnServer('mcp/servers/darkFactory.ts', env);
    return proc;
  }

  it('should respond to initialize request', async () => {
    const server = spawnMcpServer();
    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
    });

    expect(response.jsonrpc).toBe('2.0');
    expect(response.id).toBe(1);
    const result = response.result as Record<string, unknown>;
    const serverInfo = result.serverInfo as Record<string, string>;
    expect(serverInfo.name).toBe('signal-bot-dark-factory');
  });

  it('should list 2 tools', async () => {
    const server = spawnMcpServer();
    await initializeServer(server);
    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });

    const result = response.result as { tools: Array<{ name: string }> };
    expect(result.tools).toHaveLength(2);
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual(['read_dark_factory', 'start_dark_factory']);
  });

  it('should return error when DARK_FACTORY_ENABLED is not set', async () => {
    const server = spawnMcpServer();
    await initializeServer(server);
    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'start_dark_factory', arguments: { issue_number: 42 } },
    });

    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not enabled');
  });

  it('should return error when issue_number is missing for start', async () => {
    const server = spawnMcpServer({ DARK_FACTORY_ENABLED: '1' });
    await initializeServer(server);
    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'start_dark_factory', arguments: {} },
    });

    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Missing or invalid issue_number');
  });

  it('should return error when session_name is missing for read', async () => {
    const server = spawnMcpServer({ DARK_FACTORY_ENABLED: '1' });
    await initializeServer(server);
    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'read_dark_factory', arguments: {} },
    });

    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Missing or invalid session_name');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd bot && npx vitest run tests/darkFactoryMcpServer.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal server skeleton (includes `checkEnabled` gate)**

```typescript
// bot/src/mcp/servers/darkFactory.ts
import { catchErrors, error, ok } from '../result';
import { runServer } from '../runServer';
import type { McpServerDefinition } from '../types';
import { requireNumber, requireString } from '../validate';

function checkEnabled() {
  if (!process.env.DARK_FACTORY_ENABLED) {
    return error('Dark factory tools are not enabled. Set DARK_FACTORY_ENABLED=1 to use.');
  }
  return null;
}

const TOOLS = [
  {
    name: 'start_dark_factory',
    title: 'Start Dark Factory',
    description:
      'Launch a dark factory session to autonomously work on a GitHub issue. Opens a kitty terminal with a zellij session running Claude Code interactively. Returns the session name for monitoring with read_dark_factory. Requires DARK_FACTORY_ENABLED=1.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        issue_number: {
          type: 'number',
          description: 'GitHub issue number to work on',
        },
      },
      required: ['issue_number'],
    },
  },
  {
    name: 'read_dark_factory',
    title: 'Read Dark Factory Progress',
    description:
      'Read progress from a running dark factory session. Parses Claude conversation files to extract recent assistant messages and tool usage. Requires DARK_FACTORY_ENABLED=1.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        session_name: {
          type: 'string',
          description: 'The session name returned by start_dark_factory',
        },
        last_n: {
          type: 'number',
          description: 'Number of recent assistant messages to return (default: 5)',
        },
      },
      required: ['session_name'],
    },
  },
];

const handlers = {
  async start_dark_factory(args: Record<string, unknown>) {
    const gateErr = checkEnabled();
    if (gateErr) return gateErr;

    const issueNumber = requireNumber(args, 'issue_number');
    if (issueNumber.error) return issueNumber.error;

    return error('Not implemented yet');
  },

  async read_dark_factory(args: Record<string, unknown>) {
    const gateErr = checkEnabled();
    if (gateErr) return gateErr;

    const sessionName = requireString(args, 'session_name');
    if (sessionName.error) return sessionName.error;

    return error('Not implemented yet');
  },
};

export const darkFactoryServer: McpServerDefinition = {
  serverName: 'signal-bot-dark-factory',
  configKey: 'darkFactory',
  entrypoint: 'darkFactory',
  tools: TOOLS,
  handlers,
  envMapping: { DARK_FACTORY_ENABLED: 'darkFactoryEnabled' },
  onInit() {
    console.error('Dark Factory MCP server started');
  },
};

if (require.main === module) {
  runServer(darkFactoryServer);
}
```

**Step 4: Run tests to verify they pass**

Run: `cd bot && npx vitest run tests/darkFactoryMcpServer.test.ts`
Expected: 5 PASS

**Step 5: Commit**

```bash
git add bot/src/mcp/servers/darkFactory.ts bot/tests/darkFactoryMcpServer.test.ts
git commit -m "feat: scaffold dark factory MCP server with validation tests"
```

---

### Task 2: Implement `start_dark_factory` Handler

**Files:**
- Modify: `bot/src/mcp/servers/darkFactory.ts`

**Step 1: Add imports and session directory setup**

Add to top of file:
```typescript
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const execFileAsync = promisify(execFile);
```

Add helper to resolve project root (two levels up from `bot/src/mcp/servers/`):
```typescript
function projectRoot(): string {
  return path.resolve(__dirname, '..', '..', '..', '..');
}

function sessionsDir(): string {
  return path.join(projectRoot(), 'factory', 'sessions');
}
```

**Step 2: Implement the handler**

Replace the `start_dark_factory` handler:

```typescript
async start_dark_factory(args: Record<string, unknown>) {
  const gateErr = checkEnabled();
  if (gateErr) return gateErr;

  const issueNumber = requireNumber(args, 'issue_number');
  if (issueNumber.error) return issueNumber.error;

  return catchErrors(async () => {
    const timestamp = Date.now();
    const sessionName = `dark-factory-${issueNumber.value}-${timestamp}`;
    const root = projectRoot();
    const sessions = sessionsDir();

    // Ensure sessions directory exists
    fs.mkdirSync(sessions, { recursive: true });

    // Write zellij KDL layout file to temp location
    const layoutPath = path.join(os.tmpdir(), `${sessionName}.kdl`);
    const layoutContent = `layout {\n  pane command="bash" {\n    args "-c" "cd ${root} && claude \\"dark factory issue ${issueNumber.value}\\""\n    close_on_exit false\n  }\n}\n`;
    fs.writeFileSync(layoutPath, layoutContent);

    // Launch kitty with zellij using the layout
    await execFileAsync('kitty', [
      '@', 'launch', '--type=os-window',
      '--title', sessionName,
      '--', 'zellij', '-s', sessionName, '--layout', layoutPath,
    ], { timeout: 10000 });

    // Write session metadata
    const metadata = {
      sessionName,
      issueNumber: issueNumber.value,
      launchedAt: new Date().toISOString(),
      layoutPath,
    };
    fs.writeFileSync(
      path.join(sessions, `${sessionName}.json`),
      JSON.stringify(metadata, null, 2),
    );

    return ok(
      `Dark factory session started.\n` +
      `Session: ${sessionName}\n` +
      `Issue: #${issueNumber.value}\n` +
      `Use read_dark_factory with session_name "${sessionName}" to monitor progress.`
    );
  }, 'Failed to start dark factory session');
},
```

**Step 3: Run existing tests to verify nothing broke**

Run: `cd bot && npx vitest run tests/darkFactoryMcpServer.test.ts`
Expected: 5 PASS (existing tests still pass — they only test validation)

**Step 4: Commit**

```bash
git add bot/src/mcp/servers/darkFactory.ts
git commit -m "feat: implement start_dark_factory handler with kitty+zellij launch"
```

---

### Task 3: Implement `read_dark_factory` Handler

**Files:**
- Modify: `bot/src/mcp/servers/darkFactory.ts`

**Step 1: Write a test for JSONL parsing with a temp session**

Add to `bot/tests/darkFactoryMcpServer.test.ts`:

```typescript
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Add inside the describe block:

it('should return "no session found" for nonexistent session', async () => {
  const server = spawnMcpServer({ DARK_FACTORY_ENABLED: '1' });
  await initializeServer(server);
  const response = await sendAndReceive(server, {
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: { name: 'read_dark_factory', arguments: { session_name: 'nonexistent-session' } },
  });

  const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain('No session found');
});
```

**Step 2: Run test to verify it fails**

Run: `cd bot && npx vitest run tests/darkFactoryMcpServer.test.ts`
Expected: New test FAILS (handler returns "Not implemented yet" not "No session found")

**Step 3: Implement the handler**

Add helper for JSONL parsing:

```typescript
interface ParsedMessage {
  text: string;
  tools: string[];
  timestamp: string;
}

function parseConversationJSONL(filePath: string, lastN: number): ParsedMessage[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(Boolean);
  const messages: ParsedMessage[] = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type !== 'assistant' || !entry.message?.content) continue;

      const contentBlocks = entry.message.content as Array<{ type: string; text?: string; name?: string }>;
      const textParts = contentBlocks
        .filter((b) => b.type === 'text' && b.text)
        .map((b) => b.text as string);
      const toolNames = contentBlocks
        .filter((b) => b.type === 'tool_use' && b.name)
        .map((b) => b.name as string);

      if (textParts.length > 0 || toolNames.length > 0) {
        messages.push({
          text: textParts.join('\n'),
          tools: toolNames,
          timestamp: entry.timestamp || '',
        });
      }
    } catch {
      // Skip malformed lines
    }
  }

  return messages.slice(-lastN);
}
```

Replace the `read_dark_factory` handler:

```typescript
async read_dark_factory(args: Record<string, unknown>) {
  const gateErr = checkEnabled();
  if (gateErr) return gateErr;

  const sessionName = requireString(args, 'session_name');
  if (sessionName.error) return sessionName.error;
  const lastN = typeof args.last_n === 'number' ? args.last_n : 5;

  return catchErrors(() => {
    const sessions = sessionsDir();
    const metadataPath = path.join(sessions, `${sessionName.value}.json`);

    if (!fs.existsSync(metadataPath)) {
      return error(`No session found: ${sessionName.value}`);
    }

    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
    const launchedAt = new Date(metadata.launchedAt).getTime();

    // Scan Claude projects dir for JSONL files modified after launch
    // Path encoding: /home/user/project → -home-user-project (leading / becomes leading -)
    const claudeDir = path.join(
      os.homedir(),
      '.claude',
      'projects',
      projectRoot().replace(/\//g, '-'),
    );

    if (!fs.existsSync(claudeDir)) {
      return ok(`Session: ${sessionName.value}\nNo Claude conversation directory found.`);
    }

    // Find JSONL files modified after launch, then match by issue number in content
    const candidates = fs.readdirSync(claudeDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ name: f, mtime: fs.statSync(path.join(claudeDir, f)).mtimeMs }))
      .filter((f) => f.mtime >= launchedAt - 5000)
      .sort((a, b) => b.mtime - a.mtime);

    if (candidates.length === 0) {
      return ok(
        `Session: ${sessionName.value}\n` +
        `Issue: #${metadata.issueNumber}\n` +
        `No conversation file found yet. Claude may still be starting up.`
      );
    }

    // Find the file containing a user message with our dark factory prompt
    const issuePattern = `dark factory issue ${metadata.issueNumber}`;
    let jsonlPath = path.join(claudeDir, candidates[0].name); // fallback to newest
    for (const candidate of candidates) {
      const filePath = path.join(claudeDir, candidate.name);
      const head = fs.readFileSync(filePath, 'utf-8').slice(0, 5000);
      if (head.includes(issuePattern)) {
        jsonlPath = filePath;
        break;
      }
    }
    const messages = parseConversationJSONL(jsonlPath, lastN);

    if (messages.length === 0) {
      return ok(
        `Session: ${sessionName.value}\n` +
        `Issue: #${metadata.issueNumber}\n` +
        `Session started but no assistant responses yet.`
      );
    }

    let summary = `Session: ${sessionName.value}\n`;
    summary += `Issue: #${metadata.issueNumber}\n`;
    summary += `Showing last ${messages.length} messages:\n\n`;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      summary += `--- Message ${i + 1} ---\n`;
      const text = msg.text.length > 500
        ? `${msg.text.slice(0, 500)}...[truncated]`
        : msg.text;
      if (text) summary += `${text}\n`;
      if (msg.tools.length > 0) {
        summary += `Tools: ${msg.tools.join(', ')}\n`;
      }
      summary += '\n';
    }

    return ok(summary);
  }, 'Failed to read dark factory session');
},
```

**Step 4: Run tests to verify they pass**

Run: `cd bot && npx vitest run tests/darkFactoryMcpServer.test.ts`
Expected: 5 PASS

**Step 5: Commit**

```bash
git add bot/src/mcp/servers/darkFactory.ts bot/tests/darkFactoryMcpServer.test.ts
git commit -m "feat: implement read_dark_factory handler with JSONL parsing"
```

---

### Task 4: Add JSONL Parsing Unit Test

**Files:**
- Modify: `bot/tests/darkFactoryMcpServer.test.ts`

**Step 1: Write a test that creates a fake session + JSONL file and reads it**

Add a new describe block to the test file:

```typescript
describe('read_dark_factory with fake JSONL', () => {
  let proc: ChildProcess | null = null;
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dark-factory-test-'));
  });

  afterEach(() => {
    if (proc) {
      proc.kill();
      proc = null;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function spawnMcpServer(env?: Record<string, string>): ChildProcess {
    proc = spawnServer('mcp/servers/darkFactory.ts', env);
    return proc;
  }

  it('should parse assistant messages from JSONL', async () => {
    // Create a fake sessions dir and metadata file
    const sessionsPath = path.join(tempDir, 'factory', 'sessions');
    fs.mkdirSync(sessionsPath, { recursive: true });

    const sessionName = 'dark-factory-99-1234567890';
    const metadata = {
      sessionName,
      issueNumber: 99,
      launchedAt: new Date(Date.now() - 60000).toISOString(),
    };
    fs.writeFileSync(
      path.join(sessionsPath, `${sessionName}.json`),
      JSON.stringify(metadata),
    );

    // Create a fake Claude projects dir with a JSONL file
    // Path encoding: tempDir (e.g., /tmp/dark-factory-test-abc) → -tmp-dark-factory-test-abc
    const projectKey = tempDir.replace(/\//g, '-');
    const claudeProjectDir = path.join(tempDir, '.claude', 'projects', projectKey);
    fs.mkdirSync(claudeProjectDir, { recursive: true });

    const jsonlLines = [
      JSON.stringify({
        type: 'user',
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: 'dark factory issue 99' },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date().toISOString(),
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Starting dark factory for issue #99.' },
            { type: 'tool_use', name: 'Bash' },
          ],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date().toISOString(),
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Research complete. Moving to planning.' },
          ],
        },
      }),
    ];
    fs.writeFileSync(
      path.join(claudeProjectDir, 'test-session.jsonl'),
      jsonlLines.join('\n'),
    );

    // Spawn server with overridden paths and enabled flag
    const server = spawnMcpServer({
      DARK_FACTORY_PROJECT_ROOT: tempDir,
      HOME: tempDir,
      DARK_FACTORY_ENABLED: '1',
    });
    await initializeServer(server);

    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'read_dark_factory', arguments: { session_name: sessionName } },
    });

    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('issue #99');
    expect(result.content[0].text).toContain('Starting dark factory');
    expect(result.content[0].text).toContain('Research complete');
    expect(result.content[0].text).toContain('Bash');
  });
});
```

Note: This test requires the server to respect `DARK_FACTORY_PROJECT_ROOT` and `HOME` env vars for path resolution. Update the `projectRoot()` helper:

```typescript
function projectRoot(): string {
  return process.env.DARK_FACTORY_PROJECT_ROOT || path.resolve(__dirname, '..', '..', '..', '..');
}
```

The test also needs `DARK_FACTORY_ENABLED=1` in the env.

And in `read_dark_factory`, `os.homedir()` already reads the `HOME` env var.

**Step 2: Run test to verify it fails, then adjust code if needed**

Run: `cd bot && npx vitest run tests/darkFactoryMcpServer.test.ts`

**Step 3: Fix any issues until tests pass**

**Step 4: Commit**

```bash
git add bot/src/mcp/servers/darkFactory.ts bot/tests/darkFactoryMcpServer.test.ts
git commit -m "test: add JSONL parsing integration test for read_dark_factory"
```

---

### Task 5: Register Server and Add .gitignore Entry

**Files:**
- Modify: `bot/src/mcp/servers/index.ts`
- Modify: `.gitignore`

**Step 1: Add import and registration**

Add to `bot/src/mcp/servers/index.ts`:

```typescript
import { darkFactoryServer } from './darkFactory';
```

Add `darkFactoryServer` to the `ALL_SERVERS` array.

**Step 2: Add gitignore entry**

Add `factory/sessions/` to `.gitignore`.

**Step 3: Run full test suite**

Run: `cd bot && npx vitest run`
Expected: All tests PASS

**Step 4: Run lint and format**

Run: `cd bot && npm run check`
Expected: PASS

**Step 5: Commit**

```bash
git add bot/src/mcp/servers/index.ts .gitignore
git commit -m "feat: register dark factory server and gitignore sessions"
```

---

### Verification

1. `cd bot && npx vitest run` — all tests pass
2. `cd bot && npm run check` — lint + format pass
3. Manual: invoke `start_dark_factory` with a test issue, verify kitty window opens
4. Manual: invoke `read_dark_factory` after Claude runs for a bit, verify progress output
