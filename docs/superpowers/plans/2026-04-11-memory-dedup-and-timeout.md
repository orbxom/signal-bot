# Memory Dedup & Read Timeout Fix

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent duplicate memories from the main LLM and haiku extractor saving the same thing, and increase the readMemories timeout to handle cold starts.

**Architecture:** `parseClaudeOutput` already collects `toolCalls` at runtime, but the `LLMResponse` type omits the field so callers can't see it. Add `toolCalls` to `LLMResponse` so `messageHandler` can extract saved memory titles, then pass those titles through to the haiku write prompt so it knows what to skip. Bump read timeout from 10s to 30s.

**Known limitation:** `scheduleExtraction` debounces — if two messages arrive within 5s the first timer is cancelled, losing its `savedTitles`. This is the same existing behavior for `message`/`botResponse` and is acceptable for now.

**Tech Stack:** TypeScript, vitest

---

### Task 1: Add `toolCalls` to LLMResponse type

**Files:**
- Modify: `bot/src/types.ts:16-21`
- Modify: `bot/src/claudeClient.ts:121-129`
- Modify: `bot/tests/messageHandler.test.ts` (mock return values)

- [ ] **Step 1: Add `toolCalls` to `LLMResponse` and export `ToolCall`**

In `bot/src/types.ts`, add the ToolCall type and the field:

```typescript
export interface ToolCall {
  name: string;
  input?: Record<string, unknown>;
}

export interface LLMResponse {
  content: string;
  tokensUsed: number;
  sentViaMcp: boolean;
  mcpMessages: string[];
  toolCalls: ToolCall[];
}
```

- [ ] **Step 2: Remove the local `ToolCall` interface from claudeClient.ts**

In `bot/src/claudeClient.ts`, remove the local `ToolCall` interface (lines 121-124) and `ParsedClaudeOutput` interface (lines 126-129). Import `ToolCall` from `./types` instead. `parseClaudeOutput` now returns `LLMResponse & { inputTokens: number }`.

```typescript
import type { ChatMessage, LLMResponse, MessageContext, ToolCall } from './types';

// Remove:
// interface ToolCall { ... }
// interface ParsedClaudeOutput extends LLMResponse { ... }

// Update return type:
export function parseClaudeOutput(stdout: string): LLMResponse & { inputTokens: number } {
```

- [ ] **Step 3: Fix mock return values in test files**

Any test that mocks `generateResponse` needs to include `toolCalls: []` in the return. Grep for `generateResponse` mocks and add the field. Key files:
- `bot/tests/messageHandler.test.ts`
- `bot/tests/messageHandler.batch.test.ts`
- `bot/tests/messageHandler.maintenance.test.ts`

- [ ] **Step 4: Run tests and verify they pass**

Run: `cd bot && npx vitest run`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add bot/src/types.ts bot/src/claudeClient.ts bot/tests/messageHandler.test.ts bot/tests/messageHandler.batch.test.ts bot/tests/messageHandler.maintenance.test.ts
git commit -m "refactor: surface toolCalls in LLMResponse type"
```

---

### Task 2: Pass saved titles to memory extractor

**Files:**
- Modify: `bot/src/memoryExtractor.ts:81-95,101-110,131-178`
- Modify: `bot/src/messageHandler.ts:430-432`
- Test: `bot/tests/memoryExtractor.test.ts`

- [ ] **Step 1: Write failing tests**

Add tests to `bot/tests/memoryExtractor.test.ts` that verify `savedTitles` are injected into the haiku write prompt. Mock `spawnCollect` to capture the prompt argument:

```typescript
it('should include savedTitles in the write prompt', async () => {
  vi.mocked(spawnCollect).mockResolvedValue(JSON.stringify({ type: 'result', result: '' }));
  await extractor.writeMemories('group1', 'hello', 'hi there', ["Dad's birthday", 'Likes pizza']);
  const prompt = vi.mocked(spawnCollect).mock.calls[0][1][1]; // args[1] is the prompt
  expect(prompt).toContain('The bot already saved these memories');
  expect(prompt).toContain("Dad's birthday");
  expect(prompt).toContain('Likes pizza');
});

it('should NOT include savedTitles section when titles are empty', async () => {
  vi.mocked(spawnCollect).mockResolvedValue(JSON.stringify({ type: 'result', result: '' }));
  await extractor.writeMemories('group1', 'hello', 'hi there', []);
  const prompt = vi.mocked(spawnCollect).mock.calls[0][1][1];
  expect(prompt).not.toContain('already saved these memories');
});
```

Run: `cd bot && npx vitest run tests/memoryExtractor.test.ts`
Expected: FAIL — `writeMemories` doesn't accept `savedTitles` yet and prompt doesn't contain the dedup section.

- [ ] **Step 2: Update `scheduleExtraction` and `writeMemories` signatures**

In `bot/src/memoryExtractor.ts`, add optional `savedTitles` parameter to `scheduleExtraction`, `writeMemories`, and `doWriteMemories`:

```typescript
scheduleExtraction(groupId: string, message: string, botResponse: string, savedTitles?: string[]): void {
  const existing = this.timers.get(groupId);
  if (existing) {
    clearTimeout(existing);
  }

  const timer = setTimeout(() => {
    this.timers.delete(groupId);
    this.writeMemories(groupId, message, botResponse, savedTitles).catch(err => {
      logger.error(`memory-extractor: unhandled error for group ${groupId}: ${err}`);
    });
  }, DEBOUNCE_MS);

  this.timers.set(groupId, timer);
}

async writeMemories(groupId: string, message: string, botResponse: string, savedTitles?: string[]): Promise<void> {
  await this.limiter.acquire();
  try {
    await this.doWriteMemories(groupId, message, botResponse, savedTitles);
  } catch (err) {
    logger.error(`memory-extractor: writeMemories failed for group ${groupId}: ${err}`);
  } finally {
    this.limiter.release();
  }
}
```

- [ ] **Step 3: Inject saved titles into the haiku write prompt**

In `doWriteMemories`, add the `savedTitles` parameter and a conditional block after the conversation section of the prompt. **Note:** change `const prompt` to `let prompt` since we now conditionally append to it.

```typescript
private async doWriteMemories(groupId: string, message: string, botResponse: string, savedTitles?: string[]): Promise<void> {
  let prompt = `You are a memory extraction assistant. Analyze the conversation and decide what's worth remembering.

Use the Bash tool to run memory CLI commands:
DB_PATH=${this.dbPath} npx tsx ${CLI_PATH} save --group ${groupId} --title "<title>" --type <type> [--description "<desc>"] [--content "<content>"] [--tags <t1,t2>]
DB_PATH=${this.dbPath} npx tsx ${CLI_PATH} search --group ${groupId} [--keyword <kw>]
DB_PATH=${this.dbPath} npx tsx ${CLI_PATH} list-types --group ${groupId}
DB_PATH=${this.dbPath} npx tsx ${CLI_PATH} list-tags --group ${groupId}

IMPORTANT: First run list-types and list-tags to see existing categories, then search to avoid duplicates.

Save anything worth remembering: facts, preferences, URLs, plans, notable events.
Be aggressive but don't duplicate existing memories.

Conversation:
User: ${message}
Bot: ${botResponse}`;

  if (savedTitles && savedTitles.length > 0) {
    prompt += `\n\nThe bot already saved these memories during its response — do NOT save duplicates:\n${savedTitles.map(t => `- "${t}"`).join('\n')}`;
  }

  // ... rest of method unchanged
```

- [ ] **Step 4: Extract saved titles in messageHandler and pass them through**

In `bot/src/messageHandler.ts`, at line ~430, extract titles from `save_memory` tool calls and pass to `scheduleExtraction`:

```typescript
if (this.memoryExtractor) {
  const savedTitles = (response.toolCalls ?? [])
    .filter(tc => tc.name === 'mcp__memories__save_memory')
    .map(tc => tc.input?.title as string)
    .filter(Boolean);
  this.memoryExtractor.scheduleExtraction(groupId, query, response.content, savedTitles);
}
```

- [ ] **Step 5: Run tests and verify they pass**

Run: `cd bot && npx vitest run`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add bot/src/memoryExtractor.ts bot/src/messageHandler.ts bot/tests/memoryExtractor.test.ts
git commit -m "feat: pass saved memory titles to extractor to prevent duplicates"
```

---

### Task 3: Increase readMemories timeout

**Files:**
- Modify: `bot/src/memoryExtractor.ts:9`

- [ ] **Step 1: Change the timeout constant**

In `bot/src/memoryExtractor.ts` line 9, change:

```typescript
const READ_TIMEOUT_MS = 30_000;
```

- [ ] **Step 2: Run tests**

Run: `cd bot && npx vitest run tests/memoryExtractor.test.ts`
Expected: All pass.

- [ ] **Step 3: Commit**

```bash
git add bot/src/memoryExtractor.ts
git commit -m "fix: increase readMemories timeout to 30s for cold starts"
```

---

### Task 4: Run lint and full test suite

- [ ] **Step 1: Run lint**

Run: `cd bot && npm run check`
Expected: Clean — no errors or warnings.

- [ ] **Step 2: Run full test suite**

Run: `cd bot && npx vitest run`
Expected: All tests pass.

- [ ] **Step 3: Fix any issues found, then commit**
