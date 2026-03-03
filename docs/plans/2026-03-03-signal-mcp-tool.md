# Signal-Sending MCP Tool Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give Claude the ability to send messages to Signal during execution via an MCP tool, replacing the random ack with context-aware acknowledgments and allowing multi-message responses.

**Architecture:** New MCP server (`signalMcpServer.ts`) exposes a `send_message` tool that wraps the signal-cli JSON-RPC API. Claude uses this tool to send all messages (ack + final response). The bot detects MCP sends in the NDJSON output and conditionally suppresses its own auto-send. Falls back to current behavior if Claude never calls the tool.

**Tech Stack:** TypeScript, MCP stdio JSON-RPC (same as existing servers), signal-cli HTTP API, vitest

---

### Task 1: Create Signal MCP Server with TDD

**Files:**
- Create: `bot/src/signalMcpServer.ts`
- Test: `bot/tests/signalMcpServer.test.ts`

**Step 1: Write the failing test for initialize**

In `bot/tests/signalMcpServer.test.ts`:

```typescript
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { initializeServer, sendAndReceive, spawnMcpServer as spawnServer } from './helpers/mcpTestHelpers';

describe('signalMcpServer', () => {
  let proc: ChildProcess | null = null;

  afterEach(() => {
    if (proc) {
      proc.kill();
      proc = null;
    }
  });

  function spawnMcpServer(env?: Record<string, string>): ChildProcess {
    proc = spawnServer('signalMcpServer.ts', env);
    return proc;
  }

  it('should respond to initialize request', async () => {
    const server = spawnMcpServer({
      SIGNAL_CLI_URL: 'http://localhost:8080',
      SIGNAL_ACCOUNT: '+61400000000',
      MCP_GROUP_ID: 'test-group-id',
    });
    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0' },
      },
    });

    expect(response.jsonrpc).toBe('2.0');
    expect(response.id).toBe(1);
    const result = response.result as Record<string, unknown>;
    expect((result.serverInfo as Record<string, unknown>).name).toBe('signal-bot-signal');
  });

  it('should list send_message tool', async () => {
    const server = spawnMcpServer({
      SIGNAL_CLI_URL: 'http://localhost:8080',
      SIGNAL_ACCOUNT: '+61400000000',
      MCP_GROUP_ID: 'test-group-id',
    });
    await initializeServer(server);

    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    });

    const result = response.result as { tools: Array<{ name: string }> };
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('send_message');
  });

  it('should return error for unknown tool', async () => {
    const server = spawnMcpServer({
      SIGNAL_CLI_URL: 'http://localhost:8080',
      SIGNAL_ACCOUNT: '+61400000000',
      MCP_GROUP_ID: 'test-group-id',
    });
    await initializeServer(server);

    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'nonexistent', arguments: {} },
    });

    const result = response.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown tool');
  });

  it('should return error when message is missing', async () => {
    const server = spawnMcpServer({
      SIGNAL_CLI_URL: 'http://localhost:8080',
      SIGNAL_ACCOUNT: '+61400000000',
      MCP_GROUP_ID: 'test-group-id',
    });
    await initializeServer(server);

    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'send_message', arguments: {} },
    });

    const result = response.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Missing or invalid message');
  });

  it('should return error when SIGNAL_CLI_URL is not configured', async () => {
    const server = spawnMcpServer({
      SIGNAL_CLI_URL: '',
      SIGNAL_ACCOUNT: '+61400000000',
      MCP_GROUP_ID: 'test-group-id',
    });
    await initializeServer(server);

    const response = await sendAndReceive(server, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'send_message', arguments: { message: 'Hello' } },
    });

    const result = response.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('SIGNAL_CLI_URL');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd bot && npx vitest run tests/signalMcpServer.test.ts`
Expected: FAIL — cannot find `signalMcpServer.ts`

**Step 3: Write the MCP server implementation**

In `bot/src/signalMcpServer.ts`:

```typescript
import { getErrorMessage, runMcpServer, type ToolResult } from './mcpServerBase';

const SIGNAL_CLI_URL = process.env.SIGNAL_CLI_URL || '';
const SIGNAL_ACCOUNT = process.env.SIGNAL_ACCOUNT || '';
const MCP_GROUP_ID = process.env.MCP_GROUP_ID || '';

const TOOLS = [
  {
    name: 'send_message',
    title: 'Send Signal Message',
    description:
      'Send a message to the current Signal group chat. Use this to acknowledge requests, provide progress updates, and send your final response. Always use this tool to communicate — do not just return text.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        message: {
          type: 'string',
          description: 'The message text to send to the group chat',
        },
      },
      required: ['message'],
    },
  },
];

async function handleSendMessage(args: Record<string, unknown>): Promise<ToolResult> {
  const message = args.message as string;

  if (!message || typeof message !== 'string') {
    return { content: [{ type: 'text', text: 'Missing or invalid message.' }], isError: true };
  }
  if (!SIGNAL_CLI_URL) {
    return {
      content: [{ type: 'text', text: 'SIGNAL_CLI_URL environment variable is not configured.' }],
      isError: true,
    };
  }
  if (!SIGNAL_ACCOUNT) {
    return {
      content: [{ type: 'text', text: 'SIGNAL_ACCOUNT environment variable is not configured.' }],
      isError: true,
    };
  }
  if (!MCP_GROUP_ID) {
    return {
      content: [{ type: 'text', text: 'MCP_GROUP_ID environment variable is not configured.' }],
      isError: true,
    };
  }

  try {
    const response = await fetch(`${SIGNAL_CLI_URL}/api/v1/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'send',
        params: {
          account: SIGNAL_ACCOUNT,
          groupId: MCP_GROUP_ID,
          message,
        },
        id: `mcp-${Date.now()}`,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      return {
        content: [{ type: 'text', text: `Signal API error: ${response.statusText}` }],
        isError: true,
      };
    }

    const result = (await response.json()) as { error?: { message: string } };
    if (result.error) {
      return {
        content: [{ type: 'text', text: `Signal RPC error: ${result.error.message}` }],
        isError: true,
      };
    }

    return { content: [{ type: 'text', text: 'Message sent.' }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Failed to send message: ${getErrorMessage(error)}` }],
      isError: true,
    };
  }
}

async function handleToolCall(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  switch (name) {
    case 'send_message':
      return await handleSendMessage(args);
    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
}

runMcpServer({
  name: 'signal-bot-signal',
  tools: TOOLS,
  handleToolCall,
  onInit() {
    console.error(`Signal MCP server started (group: ${MCP_GROUP_ID})`);
  },
});
```

**Step 4: Run tests to verify they pass**

Run: `cd bot && npx vitest run tests/signalMcpServer.test.ts`
Expected: All 5 tests PASS (the send_message success test will pass via env validation since we don't have a real signal-cli running)

**Step 5: Commit**

```bash
git add bot/src/signalMcpServer.ts bot/tests/signalMcpServer.test.ts
git commit -m "feat: add signal MCP server for in-flight message sending"
```

---

### Task 2: Add `signalCliUrl` and `botPhoneNumber` to MessageContext

**Files:**
- Modify: `bot/src/types.ts:44-51` (add two fields to `MessageContext`)
- Test: `bot/tests/claudeClient.test.ts` (existing tests — update context objects)

**Step 1: Write the failing test**

The existing test at `bot/tests/claudeClient.test.ts:256` creates a context object without `signalCliUrl` or `botPhoneNumber`. Add a new test that checks for the signal MCP server in the config.

Add after the existing "should include MCP config when context is provided" test (around line 283):

```typescript
it('should include signal MCP server in config when context is provided', async () => {
  mockSpawnSuccess(makeResultOutput('Sent!'));

  const client = new ClaudeCLIClient();
  const messages: ChatMessage[] = [{ role: 'user', content: 'Hello' }];
  const context = {
    groupId: 'test-group',
    sender: '+61400000000',
    dbPath: '/tmp/test.db',
    timezone: 'Australia/Sydney',
    githubRepo: 'owner/repo',
    sourceRoot: '/tmp/src',
    signalCliUrl: 'http://localhost:8080',
    botPhoneNumber: '+61400000000',
  };

  await client.generateResponse(messages, context);

  const args = mockSpawn.mock.calls[0][1];
  const mcpConfigIdx = args.indexOf('--mcp-config') + 1;
  const mcpConfig = JSON.parse(args[mcpConfigIdx]);

  expect(mcpConfig.mcpServers.signal).toBeDefined();
  expect(['node', 'npx']).toContain(mcpConfig.mcpServers.signal.command);
  expect(mcpConfig.mcpServers.signal.env.SIGNAL_CLI_URL).toBe('http://localhost:8080');
  expect(mcpConfig.mcpServers.signal.env.SIGNAL_ACCOUNT).toBe('+61400000000');
  expect(mcpConfig.mcpServers.signal.env.MCP_GROUP_ID).toBe('test-group');
});
```

**Step 2: Run test to verify it fails**

Run: `cd bot && npx vitest run tests/claudeClient.test.ts -t "signal MCP server"`
Expected: FAIL — `signalCliUrl` not in `MessageContext`, no signal server in config

**Step 3: Update `MessageContext` and `claudeClient.ts`**

In `bot/src/types.ts`, add to the `MessageContext` interface (after `sourceRoot`):

```typescript
signalCliUrl: string;
botPhoneNumber: string;
```

In `bot/src/claudeClient.ts`, add to `MCP_TOOLS` (line 33, before the `].join`):

```typescript
'mcp__signal__send_message',
```

In `bot/src/claudeClient.ts`, add inside the `if (context)` block (after the `history` server definition, around line 193), add:

```typescript
const signal = resolveMcpServerPath('signalMcpServer');
```

And in the `mcpServers` object (after the `history` entry):

```typescript
signal: {
  command: signal.command,
  args: signal.args,
  env: {
    SIGNAL_CLI_URL: context.signalCliUrl,
    SIGNAL_ACCOUNT: context.botPhoneNumber,
    MCP_GROUP_ID: context.groupId,
  },
},
```

**Step 4: Update existing test contexts**

All existing test context objects in `claudeClient.test.ts` need `signalCliUrl` and `botPhoneNumber` added (there are ~4 context objects around lines 256, 343, 380, 401). Add to each:

```typescript
signalCliUrl: 'http://localhost:8080',
botPhoneNumber: '+61400000000',
```

Also update `sourceRoot` to be present in context objects that are missing it (to match the updated type).

**Step 5: Run all claudeClient tests**

Run: `cd bot && npx vitest run tests/claudeClient.test.ts`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add bot/src/types.ts bot/src/claudeClient.ts bot/tests/claudeClient.test.ts
git commit -m "feat: register signal MCP server in claude client config"
```

---

### Task 3: Add MCP Send Detection to `LLMResponse`

**Files:**
- Modify: `bot/src/types.ts:15-18` (extend `LLMResponse`)
- Modify: `bot/src/claudeClient.ts:222-285` (parse NDJSON for send_message tool_use)
- Test: `bot/tests/claudeClient.test.ts` (new tests for detection)

**Step 1: Write failing tests for MCP send detection**

Add to `bot/tests/claudeClient.test.ts` in the `generateResponse` describe block:

```typescript
it('should detect when messages were sent via MCP signal tool', async () => {
  const output = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'test' }),
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'mcp__signal__send_message',
            input: { message: 'Looking into it...' },
          },
        ],
      },
    }),
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'mcp__signal__send_message',
            input: { message: 'Here is the answer!' },
          },
        ],
      },
    }),
    JSON.stringify({
      type: 'result',
      is_error: false,
      result: 'Here is the answer!',
      usage: { output_tokens: 20 },
    }),
  ].join('\n');
  mockSpawnSuccess(output);

  const client = new ClaudeCLIClient();
  const result = await client.generateResponse([{ role: 'user', content: 'Hi' }]);

  expect(result.sentViaMcp).toBe(true);
  expect(result.mcpMessages).toEqual(['Looking into it...', 'Here is the answer!']);
});

it('should set sentViaMcp to false when no signal tool calls', async () => {
  mockSpawnSuccess(makeResultOutput('Simple response'));

  const client = new ClaudeCLIClient();
  const result = await client.generateResponse([{ role: 'user', content: 'Hi' }]);

  expect(result.sentViaMcp).toBe(false);
  expect(result.mcpMessages).toEqual([]);
});
```

**Step 2: Run tests to verify they fail**

Run: `cd bot && npx vitest run tests/claudeClient.test.ts -t "sent via MCP"`
Expected: FAIL — `sentViaMcp` and `mcpMessages` don't exist on `LLMResponse`

**Step 3: Extend `LLMResponse` and update parsing**

In `bot/src/types.ts`, update `LLMResponse`:

```typescript
export interface LLMResponse {
  content: string;
  tokensUsed: number;
  sentViaMcp: boolean;
  mcpMessages: string[];
}
```

In `bot/src/claudeClient.ts`, update the NDJSON parsing loop (the `for (const e of entries)` block around line 241). After finding `resultLine` and `lastAssistant`, also collect MCP send_message calls:

```typescript
const mcpMessages: string[] = [];
for (const e of entries) {
  if (e.type === 'result') resultLine = e as unknown as ClaudeResultLine;
  if (e.type === 'assistant') lastAssistant = e as unknown as typeof lastAssistant;

  // Detect send_message MCP tool calls
  if (e.type === 'assistant') {
    const msg = e as unknown as { message?: { content?: Array<{ type: string; name?: string; input?: { message?: string } }> } };
    for (const block of msg.message?.content || []) {
      if (block.type === 'tool_use' && block.name === 'mcp__signal__send_message' && block.input?.message) {
        mcpMessages.push(block.input.message);
      }
    }
  }
}
```

Update the return statement (around line 282) to include the new fields:

```typescript
return {
  content,
  tokensUsed: resultLine.usage?.output_tokens || 0,
  sentViaMcp: mcpMessages.length > 0,
  mcpMessages,
};
```

**Step 4: Run all tests**

Run: `cd bot && npx vitest run tests/claudeClient.test.ts`
Expected: All tests PASS (existing tests may need minor updates if they check exact return shape)

**Step 5: Commit**

```bash
git add bot/src/types.ts bot/src/claudeClient.ts bot/tests/claudeClient.test.ts
git commit -m "feat: detect MCP signal sends in claude output"
```

---

### Task 4: Update MessageHandler to Use MCP-Sent Messages

**Files:**
- Modify: `bot/src/messageHandler.ts:8-19,257-317` (remove ack, conditional response sending)
- Test: `bot/tests/messageHandler.test.ts` (update ack tests, add MCP path tests)

**Step 1: Write failing tests for the new behavior**

Update and add tests in `bot/tests/messageHandler.test.ts`:

```typescript
// Replace the existing "acknowledgement messages" describe block with:

describe('MCP-based message sending', () => {
  it('should not auto-send response when Claude sent messages via MCP', async () => {
    const mockLLM = {
      generateResponse: vi.fn().mockResolvedValue({
        content: 'Final answer',
        tokensUsed: 10,
        sentViaMcp: true,
        mcpMessages: ['Looking into it...', 'Final answer'],
      }),
    };
    const handler = new MessageHandler(['claude:'], {
      storage: mockStorage,
      llmClient: mockLLM as any,
      signalClient: mockSignal,
      botPhoneNumber: '+61000',
      signalCliUrl: 'http://localhost:8080',
    });

    await handler.handleMessage('g1', '+61111', 'claude: test', Date.now());

    // Signal client sendMessage should NOT be called — Claude handled it via MCP
    expect(mockSignal.sendMessage).not.toHaveBeenCalled();
  });

  it('should auto-send response as fallback when Claude did not use MCP', async () => {
    const mockLLM = {
      generateResponse: vi.fn().mockResolvedValue({
        content: 'Simple reply',
        tokensUsed: 10,
        sentViaMcp: false,
        mcpMessages: [],
      }),
    };
    const handler = new MessageHandler(['claude:'], {
      storage: mockStorage,
      llmClient: mockLLM as any,
      signalClient: mockSignal,
      botPhoneNumber: '+61000',
      signalCliUrl: 'http://localhost:8080',
    });

    await handler.handleMessage('g1', '+61111', 'claude: test', Date.now());

    // Fallback: bot sends the response
    expect(mockSignal.sendMessage).toHaveBeenCalledWith('g1', 'Simple reply');
  });

  it('should store each MCP-sent message in the database', async () => {
    const mockLLM = {
      generateResponse: vi.fn().mockResolvedValue({
        content: 'Final',
        tokensUsed: 10,
        sentViaMcp: true,
        mcpMessages: ['Ack message', 'Final response'],
      }),
    };
    const handler = new MessageHandler(['claude:'], {
      storage: mockStorage,
      llmClient: mockLLM as any,
      signalClient: mockSignal,
      botPhoneNumber: '+61000',
      signalCliUrl: 'http://localhost:8080',
    });

    await handler.handleMessage('g1', '+61111', 'claude: test', Date.now());

    // Each MCP message should be stored
    const botMessages = mockStorage.addMessage.mock.calls.filter(
      (call: any[]) => call[0].isBot === true,
    );
    expect(botMessages).toHaveLength(2);
    expect(botMessages[0][0].content).toBe('Ack message');
    expect(botMessages[1][0].content).toBe('Final response');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd bot && npx vitest run tests/messageHandler.test.ts -t "MCP-based"`
Expected: FAIL — `MessageHandler` still sends ack and auto-sends response

**Step 3: Update `MessageHandler`**

In `bot/src/messageHandler.ts`:

1. **Remove** the `ACK_MESSAGES` array export (lines 8-19). Keep the export but make it an empty array or remove it entirely — existing tests reference it. Actually, just remove it and update tests.

2. **Add** `signalCliUrl` to constructor options interface (after `sourceRoot`):
   ```typescript
   signalCliUrl?: string;
   ```

3. **Add** a private field:
   ```typescript
   private signalCliUrl: string;
   ```
   And in constructor: `this.signalCliUrl = options?.signalCliUrl || '';`

4. **Remove** the acknowledgement block (lines 257-263):
   ```typescript
   // DELETE THIS BLOCK:
   // try {
   //   const ackIndex = Math.floor(Math.random() * ACK_MESSAGES.length);
   //   await this.signalClient.sendMessage(groupId, ACK_MESSAGES[ackIndex]);
   // } catch (ackError) {
   //   console.error('Failed to send acknowledgement:', ackError);
   // }
   ```

5. **Update** the context passed to `generateResponse` (around line 298) to include the new fields:
   ```typescript
   const response = await this.llmClient.generateResponse(messages, {
     groupId,
     sender,
     dbPath: this.dbPath,
     timezone: this.timezone,
     githubRepo: this.githubRepo,
     sourceRoot: this.sourceRoot,
     signalCliUrl: this.signalCliUrl,
     botPhoneNumber: this.botPhoneNumber,
   });
   ```

6. **Replace** the response sending block (lines 307-317) with:
   ```typescript
   if (response.sentViaMcp) {
     // Claude sent messages directly — store each one
     for (const mcpMsg of response.mcpMessages) {
       this.storage.addMessage({
         groupId,
         sender: this.botPhoneNumber || 'bot',
         content: mcpMsg,
         timestamp: Date.now(),
         isBot: true,
       });
     }
   } else {
     // Fallback: Claude didn't use the MCP tool, send result as before
     await this.signalClient.sendMessage(groupId, response.content);
     this.storage.addMessage({
       groupId,
       sender: this.botPhoneNumber || 'bot',
       content: response.content,
       timestamp: Date.now(),
       isBot: true,
     });
   }
   ```

**Step 4: Update existing tests**

Many existing tests in `messageHandler.test.ts` reference `ACK_MESSAGES` and check for ack behavior. These need updating:

- Remove/update the `ACK_MESSAGES` describe block and individual ack tests
- Update any test that checks `sendMessage` call count (was 2 for ack+response, now depends on `sentViaMcp`)
- Update mock LLM responses to include `sentViaMcp: false, mcpMessages: []` for backward compatibility
- Update the "correct order" test that checks ack → typing → response → stopTyping

**Step 5: Run all messageHandler tests**

Run: `cd bot && npx vitest run tests/messageHandler.test.ts`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add bot/src/messageHandler.ts bot/tests/messageHandler.test.ts
git commit -m "feat: replace random ack with MCP-based message sending"
```

---

### Task 5: Pass `signalCliUrl` Through From Config to Handler

**Files:**
- Modify: `bot/src/index.ts` (pass `signalCliUrl` to MessageHandler constructor)

**Step 1: Read `bot/src/index.ts` and verify the config flow**

The config already has `signalCliUrl` (from `config.ts:79`). Just need to pass it through to the `MessageHandler` constructor.

**Step 2: Update index.ts**

In the `MessageHandler` constructor call in `bot/src/index.ts`, add:

```typescript
signalCliUrl: config.signalCliUrl,
```

**Step 3: Run full test suite**

Run: `cd bot && npx vitest run`
Expected: All 166+ tests PASS

**Step 4: Commit**

```bash
git add bot/src/index.ts
git commit -m "feat: wire signalCliUrl through to message handler"
```

---

### Task 6: Update System Prompt

**Files:**
- Modify: `bot/src/config.ts:23-24` (update DEFAULT_SYSTEM_PROMPT)

**Step 1: Update the default system prompt**

In `bot/src/config.ts`, update `DEFAULT_SYSTEM_PROMPT`:

```typescript
const DEFAULT_SYSTEM_PROMPT =
  'You are a helpful family assistant in a Signal group chat. Be friendly, concise, and helpful. Keep responses under a few sentences unless asked for detail.\n\nYou can send messages to the group chat using the send_message tool. When you receive a request:\n1. Send a brief acknowledgment showing you understand what was asked (not generic — reference the actual request)\n2. Do your work (call tools, look things up, etc.)\n3. Send your final response via send_message\n\nFor simple greetings or short replies, a single send_message call is fine — no need to acknowledge first.\nAlways use send_message for your responses.';
```

**Step 2: Run full test suite**

Run: `cd bot && npx vitest run`
Expected: All tests PASS (no tests hardcode the default system prompt)

**Step 3: Commit**

```bash
git add bot/src/config.ts
git commit -m "feat: update system prompt with send_message tool instructions"
```

---

### Task 7: Integration Test (Manual)

**Step 1: Start signal-cli**

```bash
docker compose up -d signal-cli
```

**Step 2: Run the bot in test mode**

```bash
cd bot && npm run dev:test
```

**Step 3: Test in Bot Test group**

Send messages in the Bot Test Signal group:

1. **Simple greeting**: `claude: hi` — should get a single message response (no ack needed)
2. **Weather query**: `claude: what's the weather in sydney?` — should get an ack like "Let me check the weather in Sydney..." then the actual weather
3. **Complex request**: `claude: set a reminder for tomorrow at 9am to take out the bins` — should get an ack then confirmation

**Step 4: Verify fallback**

If Claude ever returns text without using the MCP tool, the bot should still send it. This can happen if the tool is unavailable or Claude ignores the instruction.

**Step 5: Check logs**

Verify no duplicate messages, no errors in the console output.

---

## Summary of All Changes

| File | Change |
|------|--------|
| `bot/src/signalMcpServer.ts` | **New** — MCP server with `send_message` tool |
| `bot/tests/signalMcpServer.test.ts` | **New** — Tests for Signal MCP server |
| `bot/src/types.ts` | **Modify** — Add `signalCliUrl`, `botPhoneNumber` to `MessageContext`; add `sentViaMcp`, `mcpMessages` to `LLMResponse` |
| `bot/src/claudeClient.ts` | **Modify** — Register signal MCP server, detect MCP sends in output |
| `bot/tests/claudeClient.test.ts` | **Modify** — Add signal server tests, update context objects |
| `bot/src/messageHandler.ts` | **Modify** — Remove random ack, conditional send based on `sentViaMcp` |
| `bot/tests/messageHandler.test.ts` | **Modify** — Replace ack tests with MCP-path tests |
| `bot/src/index.ts` | **Modify** — Wire `signalCliUrl` through to handler |
| `bot/src/config.ts` | **Modify** — Update default system prompt |
