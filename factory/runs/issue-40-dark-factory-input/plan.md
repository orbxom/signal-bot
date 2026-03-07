# Send Dark Factory Input — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `send_dark_factory_input` MCP tool that sends keyboard input to running dark factory zellij sessions, reading terminal output first so the bot can make informed decisions about what to send.

**Architecture:** Add one new tool to the existing `darkFactory.ts` MCP server. The tool uses `zellij action dump-screen` to capture terminal state before sending input via `zellij action write-chars` + `write` (for special keys). All zellij commands use `execFileSync` (no shell) to prevent injection. Session validation reuses the existing metadata pattern.

**Tech Stack:** TypeScript, zellij CLI, Node.js `child_process.execFileSync`, vitest

**Scope note:** This PR delivers the input-sending tool (AC 1, 2, 5, 6) and the foundation for prompt handling. The LLM can auto-handle safe prompts and escalate non-obvious ones when it's invoked (AC 3, 4), but there is no autonomous monitoring loop that detects and responds to prompts without user interaction. An autonomous polling/auto-response mechanism is a follow-up concern — this tool is the building block it would use.

---

### Task 1: Tool definition, handler implementation, and tests

**Files:**
- Modify: `bot/src/mcp/servers/darkFactory.ts`
- Modify: `bot/tests/darkFactoryMcpServer.test.ts`

**Step 1: Add imports**

In `bot/src/mcp/servers/darkFactory.ts`, update the imports:

```typescript
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
```

Update the result import:
```typescript
import { catchErrors, error, getErrorMessage, ok } from '../result';
```

**Step 2: Add the tool definition to the TOOLS array**

Add a third entry after `read_dark_factory` (after line 87):

```typescript
  {
    name: 'send_dark_factory_input',
    title: 'Send Input to Dark Factory Session',
    description:
      'Send keyboard input to a running dark factory zellij session. Reads the visible terminal viewport first, sends the input, and returns the terminal context plus confirmation. Use this to respond to interactive prompts (tool-use confirmations, option selections, etc.). Use special_key for non-text input like Ctrl+C or Escape. Requires DARK_FACTORY_ENABLED=1.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        session_name: {
          type: 'string',
          description: 'The session name returned by start_dark_factory',
        },
        input: {
          type: 'string',
          description: 'Text to send to the session terminal',
        },
        press_enter: {
          type: 'boolean',
          description: 'Whether to press Enter after the text (default: true)',
        },
        special_key: {
          type: 'string',
          enum: ['ctrl-c', 'escape'],
          description: 'Send a special key instead of text input. When set, the input parameter is ignored.',
        },
      },
      required: ['session_name'],
    },
  },
```

Note: `input` is NOT required at the schema level because `special_key` can be used instead. Validation in the handler ensures at least one of `input` or `special_key` is provided.

**Step 3: Implement the handler**

Add to the `handlers` object after `read_dark_factory`:

```typescript
  async send_dark_factory_input(args: Record<string, unknown>) {
    const gateErr = checkEnabled();
    if (gateErr) return gateErr;

    const sessionName = requireString(args, 'session_name');
    if (sessionName.error) return sessionName.error;

    const specialKey = typeof args.special_key === 'string' ? args.special_key : undefined;
    if (!specialKey) {
      const input = requireString(args, 'input');
      if (input.error) return input.error;
    }

    return catchErrors(() => {
      const sessions = sessionsDir();
      const safeName = path.basename(sessionName.value);
      const metadataPath = path.join(sessions, `${safeName}.json`);

      // Verify session metadata exists
      try {
        fs.readFileSync(metadataPath, 'utf-8');
      } catch {
        return error(`No session found: ${sessionName.value}`);
      }

      // Read current terminal viewport via dump-screen
      const dumpFile = path.join(os.tmpdir(), `dump-${safeName}-${crypto.randomUUID()}.txt`);
      let screenContent: string;
      try {
        execFileSync('zellij', ['-s', safeName, 'action', 'dump-screen', dumpFile], { timeout: 5000 });
        screenContent = fs.readFileSync(dumpFile, 'utf-8');
        fs.unlinkSync(dumpFile);
      } catch {
        try { fs.unlinkSync(dumpFile); } catch {}
        return error(`Session "${sessionName.value}" is not reachable. It may have exited or the terminal window was closed.`);
      }

      // Filter blank lines and keep last 50 for context
      const lines = screenContent.split('\n').filter(line => line.trim() !== '');
      const context = lines.slice(-50).join('\n');

      // Send input — either special key or text
      // Note: zellij write-chars/write are synchronous. On zellij 0.43.1, write-chars
      // silently succeeds on detached sessions (#4535). Since dump-screen succeeded above,
      // the session was reachable moments ago, but a narrow race exists if the terminal
      // window closes between dump-screen and write-chars.
      let inputDescription: string;
      try {
        if (specialKey) {
          const keyBytes: Record<string, string> = { 'ctrl-c': '3', 'escape': '27' };
          const byte = keyBytes[specialKey];
          if (!byte) return error(`Unknown special_key: ${specialKey}`);
          execFileSync('zellij', ['-s', safeName, 'action', 'write', byte], { timeout: 5000 });
          inputDescription = specialKey;
        } else {
          const inputText = args.input as string;
          const pressEnter = args.press_enter !== false;
          execFileSync('zellij', ['-s', safeName, 'action', 'write-chars', inputText], { timeout: 5000 });
          if (pressEnter) {
            execFileSync('zellij', ['-s', safeName, 'action', 'write', '13'], { timeout: 5000 });
          }
          inputDescription = `"${inputText}"${pressEnter ? ' + Enter' : ''}`;
        }
      } catch (err) {
        return error(`Failed to send input to session: ${getErrorMessage(err)}`);
      }

      return ok(
        `Terminal context (visible viewport before input):\n${context}\n\n` +
          `---\nInput sent: ${inputDescription} to session ${safeName}`,
      );
    }, 'Failed to send input to dark factory session');
  },
```

**Step 4: Update tool count test**

In `bot/tests/darkFactoryMcpServer.test.ts`, update the tool count test:

Change `expect(result.tools).toHaveLength(2)` to `expect(result.tools).toHaveLength(3)` and update:
```typescript
expect(names).toEqual(['read_dark_factory', 'send_dark_factory_input', 'start_dark_factory']);
```

**Step 5: Add validation tests**

Add after the existing `read_dark_factory` validation tests (around line 107):

```typescript
  it('should return error when DARK_FACTORY_ENABLED is not set for send_input', async () => {
    const server = spawnMcpServer();
    await initializeServer(server);
    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 20,
      method: 'tools/call',
      params: { name: 'send_dark_factory_input', arguments: { session_name: 'test', input: 'y' } },
    });
    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not enabled');
  });

  it('should return error when session_name is missing for send_input', async () => {
    const server = spawnMcpServer({ DARK_FACTORY_ENABLED: '1' });
    await initializeServer(server);
    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 21,
      method: 'tools/call',
      params: { name: 'send_dark_factory_input', arguments: { input: 'y' } },
    });
    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Missing or invalid session_name');
  });

  it('should return error when both input and special_key are missing for send_input', async () => {
    const server = spawnMcpServer({ DARK_FACTORY_ENABLED: '1' });
    await initializeServer(server);
    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 22,
      method: 'tools/call',
      params: { name: 'send_dark_factory_input', arguments: { session_name: 'test' } },
    });
    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Missing or invalid input');
  });

  it('should return "no session found" for nonexistent session on send_input', async () => {
    const server = spawnMcpServer({ DARK_FACTORY_ENABLED: '1' });
    await initializeServer(server);
    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 23,
      method: 'tools/call',
      params: { name: 'send_dark_factory_input', arguments: { session_name: 'nonexistent', input: 'y' } },
    });
    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No session found');
  });
```

**Step 6: Add integration test for unreachable session**

Add in the "read_dark_factory with fake JSONL" describe block (after the existing JSONL test):

```typescript
    it('should return error when session exists in metadata but zellij is not reachable', async () => {
      const sessionsPath = path.join(tempDir, 'factory', 'sessions');
      fs.mkdirSync(sessionsPath, { recursive: true });

      const sessionName = 'dark-factory-99-1234567890';
      const metadata = {
        sessionName,
        issueNumber: 99,
        launchedAt: new Date().toISOString(),
      };
      fs.writeFileSync(path.join(sessionsPath, `${sessionName}.json`), JSON.stringify(metadata));

      const server = spawnMcpServer2({
        DARK_FACTORY_PROJECT_ROOT: tempDir,
        DARK_FACTORY_ENABLED: '1',
      });
      await initializeServer(server);

      const response = await sendAndReceive(server, {
        jsonrpc: '2.0',
        id: 30,
        method: 'tools/call',
        params: { name: 'send_dark_factory_input', arguments: { session_name: sessionName, input: 'y' } },
      });

      const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not reachable');
    });
```

**Step 7: Run all tests + lint**

Run: `cd bot && npx vitest run && npm run check`
Expected: All pass.

**Step 8: Commit**

```bash
git add bot/src/mcp/servers/darkFactory.ts bot/tests/darkFactoryMcpServer.test.ts
git commit -m "feat(dark-factory): add send_dark_factory_input tool with screen reading, text/special-key input, and tests

Adds a new MCP tool that sends keyboard input to running dark factory zellij
sessions. Reads the visible terminal viewport before sending input so the LLM
can make informed decisions about prompts. Supports text input (with optional
Enter), plus Ctrl+C and Escape special keys for session recovery.

Closes #40"
```

---

## Test Strategy

- **Unit tests (this PR):** Input validation (missing params, disabled gate), nonexistent session metadata, unreachable session (metadata exists but no zellij). These cover all error paths.
- **Happy path testing:** The core dump-screen + write-chars flow requires a running zellij session, which is not available in CI. This mirrors the existing pattern — `start_dark_factory` also doesn't test the actual kitty/zellij spawn. Happy path is tested during Stage 6 integration tests.
- **Integration tests (Stage 6):** Test the full flow with a real dark factory session and the mock signal server.

## Files Changed Summary

| File | Action | Description |
|------|--------|-------------|
| `bot/src/mcp/servers/darkFactory.ts` | Modify | Add tool definition + handler with dump-screen, write-chars, special keys |
| `bot/tests/darkFactoryMcpServer.test.ts` | Modify | Add validation tests, tool count update, unreachable session test |

## Notes

- **Shell safety:** `execFileSync` is used instead of `execSync` — session names and input text are passed as array arguments, not interpolated into a shell string. Input text is passed directly to zellij's `write-chars`, which sends literal characters to the terminal pane.
- **Read before write:** The tool reads the screen BEFORE sending input, so the LLM sees the current terminal state in the response. This satisfies AC 2.
- **Prompt classification left to the LLM:** The tool provides terminal context; the LLM decides whether to auto-handle (send "y" for safe prompts) or escalate (send a Signal message asking the user). This works when the bot is invoked but does not provide autonomous monitoring.
- **`special_key` parameter:** Supports `ctrl-c` (byte 3) and `escape` (byte 27) for interrupting stuck sessions, as recommended by devil's advocate review.
- **`read_dark_factory` vs `dump-screen`:** These serve different purposes. `read_dark_factory` reads structured Claude conversation data (JSONL). `send_dark_factory_input` reads the raw terminal viewport. They are complementary, not overlapping.
- **Known limitation (zellij 0.43.1 #4535):** A narrow race exists where the kitty window could close between dump-screen and write-chars, causing write-chars to silently succeed without delivering input. In practice, dump-screen succeeding confirms the session was reachable moments ago.
- **Temp file uniqueness:** Uses `crypto.randomUUID()` for dump file names to avoid collisions.
- **Blank line filtering:** Terminal viewport dumps contain many blank lines. These are filtered out before returning context to keep the response focused.

## Revisions

Changes from initial plan based on devil's advocate review:

1. **Added `special_key` parameter** (ctrl-c, escape) — addresses the "how do you recover from a stuck session" concern. (Review #6)
2. **Made `input` conditionally required** — only required when `special_key` is not set. (Follows from #6)
3. **Added `crypto.randomUUID()` for temp files** — prevents name collisions. (Review #5)
4. **Filter blank lines from viewport** — terminal dumps have many blank lines; filtering keeps context focused. Description changed from "last 50 lines" to "visible viewport." (Review #3)
5. **Added scope note** — explicitly acknowledges that autonomous monitoring (AC 3, 4) is not in scope. The tool enables the LLM to handle prompts when invoked, but no polling loop is included. (Review #1, #12)
6. **Consolidated to 1 task** — the 4-task breakdown was over-granular for ~80 lines of new code. (Review #10)
7. **Added race condition comment** — documents the zellij 0.43.1 silent-failure race as a known limitation. (Review #2)
8. **Dismissed: happy path mocking** — tests spawn the MCP server as a subprocess, making internal mocking impractical. Same pattern as existing `start_dark_factory`. (Review #9)
9. **Dismissed: whitespace-only input rejection** — valid whitespace input (e.g., pressing Space in a TUI) should not be blocked. (Review #7)
