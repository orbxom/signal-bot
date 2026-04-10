# Enhanced Memory System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-update dossiers and memories after every bot response, free up ~1,400 tokens by slimming skill files, and consolidate memories daily with conversation summaries.

**Architecture:** Three features: (1) A `MemoryExtractor` class spawns a lightweight `claude -p` call after each bot response to extract dossier/memory updates as JSON. (2) Skill markdown files are replaced with a condensed constant in `contextBuilder.ts`. (3) A `MemoryConsolidator` class runs daily at 3am AEDT to merge/trim memories and produce daily summaries.

**Tech Stack:** TypeScript, `child_process.spawn`, SQLite via `better-sqlite3`, vitest for tests

**Spec:** `docs/superpowers/specs/2026-03-18-enhanced-memory-system-design.md`

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `bot/src/memoryExtractor.ts` | Background extraction: debounce, spawn Claude, parse JSON, apply DB updates |
| `bot/src/memoryConsolidator.ts` | Daily consolidation: schedule check, spawn Claude, apply rewrites, store daily summaries |
| `bot/tests/memoryExtractor.test.ts` | Unit tests for extraction |
| `bot/tests/memoryConsolidator.test.ts` | Unit tests for consolidation |

### Modified Files
| File | Changes |
|------|---------|
| `bot/src/contextBuilder.ts` | Remove `loadSkillContent()`, `cachedSkillContent`. Add `CAPABILITIES_PROMPT` constant. |
| `bot/src/messageHandler.ts` | Accept `MemoryExtractor` in constructor. Fire extraction after bot response. Remove skill loading from `assembleAdditionalContext()`. |
| `bot/src/index.ts` | Create `MemoryExtractor` and `MemoryConsolidator`. Register extraction limiter in shutdown. Add daily consolidation to maintenance loop. |

### Deleted Files
| File | Reason |
|------|--------|
| `bot/src/skills/dossier-maintenance.md` | Replaced by `CAPABILITIES_PROMPT` constant |
| `bot/src/skills/memory-maintenance.md` | Replaced by `CAPABILITIES_PROMPT` constant |
| `bot/src/skills/persona-management.md` | Replaced by `CAPABILITIES_PROMPT` constant |
| `bot/src/skills/feature-requests.md` | Replaced by `CAPABILITIES_PROMPT` constant |

---

## Task 1: Skills Slimming (contextBuilder + messageHandler)

Start here — it's the simplest change and unblocks the other two.

**Files:**
- Modify: `bot/src/contextBuilder.ts:7-28,50-58,157-172`
- Modify: `bot/src/messageHandler.ts:313-316`
- Delete: `bot/src/skills/*.md`
- Test: `bot/tests/contextBuilder.test.ts`

- [ ] **Step 1: Write failing test — capabilities prompt replaces skills**

Add to `bot/tests/contextBuilder.test.ts`:

```typescript
it('should include capabilities prompt in system content', () => {
  const builder = new ContextBuilder(defaultConfig);
  const chatMessages = builder.buildContext({
    history: [],
    query: 'Hello',
    groupId: 'g1',
    sender: 'Alice',
  });

  const system = chatMessages[0].content;
  expect(system).toContain('update_dossier');
  expect(system).toContain('save_memory');
  expect(system).toContain('switch_persona');
  expect(system).toContain('search_messages');
});

it('should not contain loadSkillContent method', () => {
  const builder = new ContextBuilder(defaultConfig);
  expect((builder as any).loadSkillContent).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd bot && npx vitest run tests/contextBuilder.test.ts`
Expected: FAIL — `loadSkillContent` still exists, capabilities text not in system content

- [ ] **Step 3: Replace skills with capabilities constant in contextBuilder.ts**

In `bot/src/contextBuilder.ts`:

1. Remove the `import fs` and `import path` lines (no longer needed for skill loading)
2. Remove the `cachedSkillContent` field from the class (line 58)
3. Remove the entire `loadSkillContent()` method (lines 157-172)
4. Add a new constant after the existing instruction constants:

```typescript
const CAPABILITIES_PROMPT = `## Your Capabilities
- Dossier tools (update_dossier, get_dossier, list_dossiers) — store/retrieve info about people in this group
- Memory tools (save_memory, get_memory, list_memories, delete_memory) — store/retrieve group facts, plans, preferences
- Persona tools (create_persona, list_personas, switch_persona) — create or switch bot personalities
- Message history (search_messages, get_messages_by_date) — search past conversations
- Image viewing (view_image) — view images shared in the group
- Feature requests (create_feature_request) — file ideas via GitHub
- Reminders (set_reminder, list_reminders) — schedule one-time or recurring reminders
- Weather (get_weather_observations, get_weather_forecast) — Australian weather via BOM
When someone shares personal info, you may update their dossier. When the group decides something worth remembering, save it as a memory.`;
```

5. Add `CAPABILITIES_PROMPT` to the `timeContext` array in `buildContext()` (after `IMAGE_INSTRUCTIONS`):

```typescript
const timeContext = [
  `Current time: ${isoString} (Unix ms: ${unixMs})`,
  `Timezone: ${this.timezone}`,
  `Group ID: ${groupId}`,
  `Current requester: ${nameMap?.get(sender) ? `${nameMap.get(sender)} (${sender})` : sender}`,
  SOURCE_CODE_INSTRUCTIONS,
  MEMORY_INSTRUCTIONS,
  VOICE_MESSAGE_INSTRUCTIONS,
  IMAGE_INSTRUCTIONS,
  CAPABILITIES_PROMPT,
].join('\n');
```

- [ ] **Step 4: Remove skill loading from messageHandler.ts**

In `bot/src/messageHandler.ts`, in `assembleAdditionalContext()`, remove lines 313-316:

```typescript
// DELETE these lines:
const skillContent = this.contextBuilder.loadSkillContent();
if (skillContent) {
  contextParts.push(skillContent);
}
```

- [ ] **Step 5: Delete skill markdown files**

```bash
rm bot/src/skills/dossier-maintenance.md
rm bot/src/skills/memory-maintenance.md
rm bot/src/skills/persona-management.md
rm bot/src/skills/feature-requests.md
rmdir bot/src/skills 2>/dev/null || true
```

- [ ] **Step 6: Run all tests**

Run: `cd bot && npx vitest run`
Expected: All pass. Some existing contextBuilder tests may need token budget adjustments if they were sensitive to system prompt size.

- [ ] **Step 7: Commit**

```bash
git add -A bot/src/contextBuilder.ts bot/src/messageHandler.ts bot/tests/contextBuilder.test.ts
git add bot/src/skills/  # stages deletions
git commit -m "feat: replace skill files with condensed capabilities prompt

Removes 4 skill markdown files (~1,934 tokens) and replaces them
with a ~300 token CAPABILITIES_PROMPT constant. Frees ~1,400 tokens
for chat history in every request."
```

---

## Task 2: MemoryExtractor — Core Logic

**Files:**
- Create: `bot/src/memoryExtractor.ts`
- Test: `bot/tests/memoryExtractor.test.ts`

- [ ] **Step 1: Write failing tests for JSON parsing and DB application**

Create `bot/tests/memoryExtractor.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage } from '../src/storage';
import { DatabaseConnection } from '../src/db';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Mock spawnPromise and logger
const { mockSpawnPromise } = vi.hoisted(() => {
  const mockSpawnPromise = vi.fn();
  return { mockSpawnPromise };
});

vi.mock('../src/claudeClient', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/claudeClient')>();
  return { ...actual, spawnPromise: mockSpawnPromise };
});

vi.mock('../src/logger', () => ({
  logger: { step: vi.fn(), info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { MemoryExtractor } from '../src/memoryExtractor';

function makeTempDb(): Storage {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'extractor-test-'));
  return new Storage(path.join(dir, 'test.db'));
}

function makeClaudeOutput(json: object): string {
  return JSON.stringify([
    { type: 'result', result: JSON.stringify(json), is_error: false, usage: { input_tokens: 10, output_tokens: 50 } },
  ]);
}

describe('MemoryExtractor', () => {
  let storage: Storage;
  let extractor: MemoryExtractor;

  beforeEach(() => {
    vi.clearAllMocks();
    storage = makeTempDb();
    extractor = new MemoryExtractor(storage);
  });

  describe('parseAndApply', () => {
    it('should upsert a new dossier from extraction result', async () => {
      mockSpawnPromise.mockResolvedValue({
        stdout: makeClaudeOutput({
          dossierUpdates: [{ action: 'update', personId: 'user-1', displayName: 'Alice', notes: 'Likes cats' }],
          memoryUpdates: [],
        }),
      });

      await extractor.extract('group-1');

      const dossier = storage.dossiers.get('group-1', 'user-1');
      expect(dossier).not.toBeNull();
      expect(dossier!.displayName).toBe('Alice');
      expect(dossier!.notes).toBe('Likes cats');
    });

    it('should add a new memory from extraction result', async () => {
      mockSpawnPromise.mockResolvedValue({
        stdout: makeClaudeOutput({
          dossierUpdates: [],
          memoryUpdates: [{ action: 'add', topic: 'pizza night', content: 'Every Friday at 7pm' }],
        }),
      });

      await extractor.extract('group-1');

      const memory = storage.memories.get('group-1', 'pizza night');
      expect(memory).not.toBeNull();
      expect(memory!.content).toBe('Every Friday at 7pm');
    });

    it('should delete a memory when action is delete', async () => {
      storage.memories.upsert('group-1', 'old-topic', 'stale info');

      mockSpawnPromise.mockResolvedValue({
        stdout: makeClaudeOutput({
          dossierUpdates: [],
          memoryUpdates: [{ action: 'delete', topic: 'old-topic' }],
        }),
      });

      await extractor.extract('group-1');

      const memory = storage.memories.get('group-1', 'old-topic');
      expect(memory).toBeNull();
    });

    it('should handle empty extraction result gracefully', async () => {
      mockSpawnPromise.mockResolvedValue({
        stdout: makeClaudeOutput({ dossierUpdates: [], memoryUpdates: [] }),
      });

      await expect(extractor.extract('group-1')).resolves.not.toThrow();
    });

    it('should handle malformed JSON gracefully', async () => {
      mockSpawnPromise.mockResolvedValue({
        stdout: JSON.stringify([
          { type: 'result', result: 'not valid json {{{', is_error: false, usage: {} },
        ]),
      });

      await expect(extractor.extract('group-1')).resolves.not.toThrow();
    });

    it('should handle spawn failure gracefully', async () => {
      mockSpawnPromise.mockRejectedValue(new Error('spawn failed'));

      await expect(extractor.extract('group-1')).resolves.not.toThrow();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd bot && npx vitest run tests/memoryExtractor.test.ts`
Expected: FAIL — `MemoryExtractor` module doesn't exist

- [ ] **Step 3: Implement MemoryExtractor**

Create `bot/src/memoryExtractor.ts`:

```typescript
import { spawn } from 'node:child_process';
import { logger } from './logger';
import { SpawnLimiter } from './spawnLimiter';
import type { Storage } from './storage';

interface DossierUpdate {
  action: 'add' | 'update';
  personId: string;
  displayName: string;
  notes: string;
}

interface MemoryUpdate {
  action: 'add' | 'update' | 'delete';
  topic: string;
  content?: string;
}

interface ExtractionResult {
  dossierUpdates: DossierUpdate[];
  memoryUpdates: MemoryUpdate[];
}

const EXTRACTION_PROMPT = `You are a memory extraction assistant. Review the recent conversation and current records below.
Output a JSON object with updates needed. ONLY output updates for genuinely NEW information not already captured.

Rules:
- For dossier updates: output the COMPLETE merged notes (existing + new facts). Do not repeat what is unchanged.
- For memory updates: save group-level facts, plans, decisions. Not individual preferences (those go in dossiers).
- Use action "add" for new entries, "update" for changed facts, "delete" for contradicted/stale info.
- If nothing new was learned, output empty arrays.
- Output ONLY valid JSON, no markdown fences, no explanation.

Schema:
{
  "dossierUpdates": [{ "action": "add"|"update", "personId": "...", "displayName": "...", "notes": "..." }],
  "memoryUpdates": [{ "action": "add"|"update"|"delete", "topic": "...", "content": "..." }]
}`;

const EXTRACTION_TIMEOUT_MS = 30_000;

export const extractionLimiter = new SpawnLimiter(1);

export class MemoryExtractor {
  private storage: Storage;
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(storage: Storage) {
    this.storage = storage;
  }

  /** Schedule an extraction for a group, debounced by 5 seconds. */
  scheduleExtraction(groupId: string): void {
    const existing = this.debounceTimers.get(groupId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.debounceTimers.delete(groupId);
      this.extract(groupId).catch(err => {
        logger.error(`Memory extraction failed for ${groupId}:`, err);
      });
    }, 5000);

    this.debounceTimers.set(groupId, timer);
  }

  /** Run extraction immediately for a group. Exported for testing. */
  async extract(groupId: string): Promise<void> {
    try {
      const messages = this.storage.getRecentMessages(groupId, 20);
      if (messages.length === 0) return;

      const dossiers = this.storage.getDossiersByGroup(groupId);
      const memories = this.storage.getMemoriesByGroup(groupId);

      const contextLines: string[] = [];

      if (dossiers.length > 0) {
        contextLines.push('## Current Dossiers');
        for (const d of dossiers) {
          contextLines.push(`- ${d.displayName} (${d.personId}): ${d.notes || '(no notes)'}`);
        }
      }

      if (memories.length > 0) {
        contextLines.push('\n## Current Memories');
        for (const m of memories) {
          contextLines.push(`- ${m.topic}: ${m.content}`);
        }
      }

      contextLines.push('\n## Recent Conversation');
      for (const msg of messages) {
        const who = msg.isBot ? 'Bot' : msg.sender;
        contextLines.push(`[${new Date(msg.timestamp).toISOString()}] ${who}: ${msg.content}`);
      }

      const prompt = contextLines.join('\n');

      const args = [
        '-p', prompt,
        '--output-format', 'json',
        '--max-turns', '1',
        '--no-session-persistence',
        '--system-prompt', EXTRACTION_PROMPT,
        '--allowedTools', '',
      ];

      const { stdout } = await this.spawnClaude(args);
      const result = this.parseResult(stdout);
      if (result) {
        this.applyUpdates(groupId, result);
      }
    } catch (error) {
      logger.error(`Memory extraction error for ${groupId}:`, error);
    }
  }

  private async spawnClaude(args: string[]): Promise<{ stdout: string }> {
    await extractionLimiter.acquire();
    try {
      return await new Promise((resolve, reject) => {
        const child = spawn('claude', args, {
          env: { ...process.env, CLAUDECODE: '' },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        child.stdin.end();
        extractionLimiter.trackChild(child);

        const chunks: Buffer[] = [];
        child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));

        const timer = setTimeout(() => {
          child.kill();
          setTimeout(() => { try { if (!child.killed) child.kill('SIGKILL'); } catch {} }, 5000);
          reject(new Error('Extraction timed out'));
        }, EXTRACTION_TIMEOUT_MS);

        child.on('close', code => {
          clearTimeout(timer);
          if (code !== 0) reject(new Error(`claude exited with code ${code}`));
          else resolve({ stdout: Buffer.concat(chunks).toString() });
        });
        child.on('error', err => { clearTimeout(timer); reject(err); });
      });
    } finally {
      extractionLimiter.release();
    }
  }

  private parseResult(stdout: string): ExtractionResult | null {
    try {
      // Parse NDJSON/JSON array format from Claude CLI
      const trimmed = stdout.trim();
      const entries = trimmed.startsWith('[') ? JSON.parse(trimmed) : trimmed.split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const resultEntry = entries.find((e: any) => e.type === 'result');
      if (!resultEntry?.result) return null;

      const parsed = JSON.parse(resultEntry.result);
      if (!parsed.dossierUpdates || !parsed.memoryUpdates) return null;
      return parsed as ExtractionResult;
    } catch {
      logger.warn('Failed to parse extraction result');
      return null;
    }
  }

  private applyUpdates(groupId: string, result: ExtractionResult): void {
    let changes = 0;

    for (const d of result.dossierUpdates) {
      if (!d.personId || !d.displayName) continue;
      try {
        this.storage.upsertDossier(groupId, d.personId, d.displayName, d.notes || '');
        changes++;
      } catch (error) {
        logger.warn(`Failed to upsert dossier for ${d.displayName}:`, error);
      }
    }

    for (const m of result.memoryUpdates) {
      if (!m.topic) continue;
      try {
        if (m.action === 'delete') {
          this.storage.deleteMemory(groupId, m.topic);
          changes++;
        } else if (m.content) {
          this.storage.upsertMemory(groupId, m.topic, m.content);
          changes++;
        }
      } catch (error) {
        logger.warn(`Failed to apply memory update for "${m.topic}":`, error);
      }
    }

    if (changes > 0) {
      logger.info(`Memory extraction: ${changes} update(s) applied for group ${groupId.substring(0, 8)}...`);
    }
  }

  clearTimers(): void {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd bot && npx vitest run tests/memoryExtractor.test.ts`
Expected: All 6 tests pass

- [ ] **Step 5: Run full test suite**

Run: `cd bot && npx vitest run`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add bot/src/memoryExtractor.ts bot/tests/memoryExtractor.test.ts
git commit -m "feat: add MemoryExtractor for background memory updates

Spawns a lightweight Claude call after bot responses to auto-extract
dossier and memory updates as JSON. Debounced (5s), max 1 concurrent,
30s timeout. Failures are logged silently."
```

---

## Task 3: Wire MemoryExtractor into MessageHandler + Index

**Files:**
- Modify: `bot/src/messageHandler.ts:22-74,392-447`
- Modify: `bot/src/index.ts:1-11,40-43,79-86`
- Test: `bot/tests/messageHandler.test.ts`

- [ ] **Step 1: Write failing test — extraction is triggered after bot response**

Add to `bot/tests/messageHandler.test.ts` (or create a new describe block):

```typescript
it('should schedule memory extraction after successful bot response', async () => {
  const mockExtractor = { scheduleExtraction: vi.fn(), clearTimers: vi.fn() };
  // Pass extractor to handler via options or dependency injection
  // Verify mockExtractor.scheduleExtraction was called with groupId after handleMessage
});
```

The exact test structure depends on how the existing tests mock dependencies. Follow the pattern in `messageHandler.test.ts`.

- [ ] **Step 2: Add MemoryExtractor to MessageHandler**

In `bot/src/messageHandler.ts`:

1. Add import: `import type { MemoryExtractor } from './memoryExtractor';`
2. Add optional field to constructor deps: `memoryExtractor?: MemoryExtractor`
3. Store as `this.memoryExtractor`
4. After the bot response is stored in `processLlmRequest()` (after line 447, before `logger.groupEnd()`), add:

```typescript
// Fire background memory extraction (non-blocking)
if (this.memoryExtractor) {
  this.memoryExtractor.scheduleExtraction(groupId);
}
```

- [ ] **Step 3: Wire up in index.ts**

In `bot/src/index.ts`:

1. Add imports:
```typescript
import { MemoryExtractor, extractionLimiter } from './memoryExtractor';
```

2. After creating `storage` (line 18), create the extractor:
```typescript
const memoryExtractor = new MemoryExtractor(storage);
```

3. Pass it to `MessageHandler` constructor deps:
```typescript
{
  storage,
  llmClient,
  signalClient,
  appConfig,
  memoryExtractor,
},
```

4. In the shutdown handler (line 80-86), add:
```typescript
memoryExtractor.clearTimers();
extractionLimiter.killAll();
```

- [ ] **Step 4: Run tests**

Run: `cd bot && npx vitest run`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add bot/src/messageHandler.ts bot/src/index.ts bot/tests/messageHandler.test.ts
git commit -m "feat: wire MemoryExtractor into message handling pipeline

Extraction triggers after every bot response with 5s debounce.
Extraction limiter registered with shutdown handler."
```

---

## Task 4: MemoryConsolidator — Core Logic

**Files:**
- Create: `bot/src/memoryConsolidator.ts`
- Test: `bot/tests/memoryConsolidator.test.ts`

- [ ] **Step 1: Write failing tests**

Create `bot/tests/memoryConsolidator.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage } from '../src/storage';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const { mockSpawnPromise } = vi.hoisted(() => {
  const mockSpawnPromise = vi.fn();
  return { mockSpawnPromise };
});

vi.mock('../src/claudeClient', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/claudeClient')>();
  return { ...actual, spawnPromise: mockSpawnPromise };
});

vi.mock('../src/logger', () => ({
  logger: { step: vi.fn(), info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { MemoryConsolidator } from '../src/memoryConsolidator';

function makeTempDb(): Storage {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consolidator-test-'));
  return new Storage(path.join(dir, 'test.db'));
}

function makeClaudeOutput(json: object): string {
  return JSON.stringify([
    { type: 'result', result: JSON.stringify(json), is_error: false, usage: { input_tokens: 10, output_tokens: 50 } },
  ]);
}

describe('MemoryConsolidator', () => {
  let storage: Storage;
  let consolidator: MemoryConsolidator;

  beforeEach(() => {
    vi.clearAllMocks();
    storage = makeTempDb();
    consolidator = new MemoryConsolidator(storage, 'Australia/Sydney');
  });

  it('should not run if already ran today', async () => {
    // Set last run to now
    storage.conn.db.prepare(
      "INSERT INTO schema_meta (key, value) VALUES ('consolidation_last_run', ?)"
    ).run(String(Date.now()));

    await consolidator.runIfDue();
    expect(mockSpawnPromise).not.toHaveBeenCalled();
  });

  it('should store daily summary with __daily: prefix', async () => {
    // Add a message so the group is "active"
    storage.addMessage({
      groupId: 'g1', sender: 'alice', content: 'hello',
      timestamp: Date.now() - 1000, isBot: false,
    });

    mockSpawnPromise.mockResolvedValue({
      stdout: makeClaudeOutput({
        dossierUpdates: [],
        memoryUpdates: [],
        dailySummary: 'Alice said hello. Quiet day.',
      }),
    });

    await consolidator.consolidateGroup('g1');

    const memories = storage.memories.getByGroup('g1');
    const daily = memories.find(m => m.topic.startsWith('__daily:'));
    expect(daily).toBeTruthy();
    expect(daily!.content).toBe('Alice said hello. Quiet day.');
  });

  it('should trim daily summaries older than 14 days', async () => {
    // Insert an old daily summary
    storage.memories.upsert('g1', '__daily:2026-03-01', 'old summary');
    storage.memories.upsert('g1', '__daily:2026-03-17', 'recent summary');

    // Consolidator should delete __daily:2026-03-01 (>14 days old)
    consolidator.trimOldDailies('g1', 14);

    const old = storage.memories.get('g1', '__daily:2026-03-01');
    const recent = storage.memories.get('g1', '__daily:2026-03-17');
    expect(old).toBeNull();
    expect(recent).not.toBeNull();
  });

  it('should handle spawn failure gracefully', async () => {
    storage.addMessage({
      groupId: 'g1', sender: 'alice', content: 'hello',
      timestamp: Date.now() - 1000, isBot: false,
    });

    mockSpawnPromise.mockRejectedValue(new Error('spawn failed'));
    await expect(consolidator.consolidateGroup('g1')).resolves.not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd bot && npx vitest run tests/memoryConsolidator.test.ts`
Expected: FAIL — `MemoryConsolidator` module doesn't exist

- [ ] **Step 3: Implement MemoryConsolidator**

Create `bot/src/memoryConsolidator.ts`:

```typescript
import { logger } from './logger';
import { estimateTokens } from './mcp/result';
import { SpawnLimiter } from './spawnLimiter';
import type { Storage } from './storage';

interface ConsolidationResult {
  dossierUpdates: Array<{ action: string; personId: string; displayName: string; notes: string }>;
  memoryUpdates: Array<{ action: string; topic: string; content?: string }>;
  dailySummary: string;
}

const CONSOLIDATION_PROMPT = `You are a memory consolidation assistant. Review the dossiers, memories, and today's conversation for this group.

Tasks:
1. Review dossiers: merge duplicate facts, remove stale info, rewrite for conciseness
2. Review memories: merge related topics, remove outdated entries
3. Write a brief daily summary (2-3 sentences) of today's conversations

Output ONLY valid JSON:
{
  "dossierUpdates": [{ "action": "update", "personId": "...", "displayName": "...", "notes": "..." }],
  "memoryUpdates": [{ "action": "add"|"update"|"delete", "topic": "...", "content": "..." }],
  "dailySummary": "Brief summary of today's conversations"
}

If nothing needs changing, output empty arrays and still provide the daily summary.`;

const CONSOLIDATION_TIMEOUT_MS = 60_000;
const MESSAGE_TOKEN_BUDGET = 4000;
const DAILY_RETENTION_DAYS = 14;

export const consolidationLimiter = new SpawnLimiter(1);

export class MemoryConsolidator {
  private storage: Storage;
  private timezone: string;

  constructor(storage: Storage, timezone: string) {
    this.storage = storage;
    this.timezone = timezone;
  }

  /** Run consolidation if it hasn't been run today. */
  async runIfDue(): Promise<void> {
    const lastRun = this.getLastRun();
    const now = new Date();
    const todayStr = this.getTodayString(now);

    if (lastRun && this.getTodayString(new Date(lastRun)) === todayStr) {
      return; // Already ran today
    }

    logger.info('Starting daily memory consolidation...');
    const groupIds = this.storage.getDistinctGroupIds();

    for (const groupId of groupIds) {
      try {
        await this.consolidateGroup(groupId);
      } catch (error) {
        logger.error(`Consolidation failed for group ${groupId.substring(0, 8)}...:`, error);
      }
    }

    this.setLastRun(Date.now());
    logger.info('Daily memory consolidation complete');
  }

  /** Consolidate a single group. Exported for testing. */
  async consolidateGroup(groupId: string): Promise<void> {
    try {
      const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
      const messages = this.storage.messages.getByDateRange(groupId, oneDayAgo);
      if (messages.length === 0) return;

      const dossiers = this.storage.getDossiersByGroup(groupId);
      const memories = this.storage.getMemoriesByGroup(groupId);

      const contextLines: string[] = [];

      if (dossiers.length > 0) {
        contextLines.push('## Current Dossiers');
        for (const d of dossiers) {
          contextLines.push(`- ${d.displayName} (${d.personId}): ${d.notes || '(no notes)'}`);
        }
      }

      if (memories.length > 0) {
        contextLines.push('\n## Current Memories');
        for (const m of memories) {
          contextLines.push(`- ${m.topic}: ${m.content}`);
        }
      }

      // Token-bounded message inclusion
      contextLines.push('\n## Today\'s Conversation');
      let tokenCount = 0;
      for (const msg of messages) {
        const who = msg.isBot ? 'Bot' : msg.sender;
        const line = `[${new Date(msg.timestamp).toISOString()}] ${who}: ${msg.content}`;
        const tokens = estimateTokens(line);
        if (tokenCount + tokens > MESSAGE_TOKEN_BUDGET) break;
        tokenCount += tokens;
        contextLines.push(line);
      }

      const prompt = contextLines.join('\n');

      const { spawn } = await import('node:child_process');
      const args = [
        '-p', prompt,
        '--output-format', 'json',
        '--max-turns', '1',
        '--no-session-persistence',
        '--system-prompt', CONSOLIDATION_PROMPT,
        '--allowedTools', '',
      ];

      await consolidationLimiter.acquire();
      let stdout: string;
      try {
        stdout = await new Promise<string>((resolve, reject) => {
          const child = spawn('claude', args, {
            env: { ...process.env, CLAUDECODE: '' },
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          child.stdin.end();
          consolidationLimiter.trackChild(child);

          const chunks: Buffer[] = [];
          child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));

          const timer = setTimeout(() => {
            child.kill();
            reject(new Error('Consolidation timed out'));
          }, CONSOLIDATION_TIMEOUT_MS);

          child.on('close', code => {
            clearTimeout(timer);
            if (code !== 0) reject(new Error(`claude exited with code ${code}`));
            else resolve(Buffer.concat(chunks).toString());
          });
          child.on('error', err => { clearTimeout(timer); reject(err); });
        });
      } finally {
        consolidationLimiter.release();
      }

      const result = this.parseResult(stdout);
      if (!result) return;

      // Apply all updates in a transaction
      this.storage.conn.transaction(() => {
        for (const d of result.dossierUpdates) {
          if (!d.personId || !d.displayName) continue;
          try {
            this.storage.upsertDossier(groupId, d.personId, d.displayName, d.notes || '');
          } catch (error) {
            logger.warn(`Consolidation: failed to upsert dossier ${d.displayName}:`, error);
          }
        }

        for (const m of result.memoryUpdates) {
          if (!m.topic) continue;
          try {
            if (m.action === 'delete') {
              this.storage.deleteMemory(groupId, m.topic);
            } else if (m.content) {
              this.storage.upsertMemory(groupId, m.topic, m.content);
            }
          } catch (error) {
            logger.warn(`Consolidation: failed to apply memory "${m.topic}":`, error);
          }
        }

        // Store daily summary
        if (result.dailySummary) {
          const dateStr = this.getTodayString(new Date());
          try {
            this.storage.upsertMemory(groupId, `__daily:${dateStr}`, result.dailySummary);
          } catch (error) {
            logger.warn(`Consolidation: failed to store daily summary:`, error);
          }
        }

        // Trim old dailies
        this.trimOldDailies(groupId, DAILY_RETENTION_DAYS);
      });

      logger.info(`Consolidation complete for group ${groupId.substring(0, 8)}...`);
    } catch (error) {
      logger.error(`Consolidation error for group ${groupId.substring(0, 8)}...:`, error);
    }
  }

  /** Remove __daily: summaries older than retentionDays. Exported for testing. */
  trimOldDailies(groupId: string, retentionDays: number): void {
    const memories = this.storage.memories.getByGroup(groupId);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);
    const cutoffStr = this.getTodayString(cutoff);

    for (const m of memories) {
      if (m.topic.startsWith('__daily:')) {
        const dateStr = m.topic.replace('__daily:', '');
        if (dateStr < cutoffStr) {
          this.storage.deleteMemory(groupId, m.topic);
        }
      }
    }
  }

  private parseResult(stdout: string): ConsolidationResult | null {
    try {
      const trimmed = stdout.trim();
      const entries = trimmed.startsWith('[') ? JSON.parse(trimmed) : trimmed.split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const resultEntry = entries.find((e: any) => e.type === 'result');
      if (!resultEntry?.result) return null;
      return JSON.parse(resultEntry.result) as ConsolidationResult;
    } catch {
      logger.warn('Failed to parse consolidation result');
      return null;
    }
  }

  private getTodayString(date: Date): string {
    return date.toLocaleDateString('en-CA', { timeZone: this.timezone });
  }

  private getLastRun(): number | null {
    const row = this.storage.conn.db
      .prepare("SELECT value FROM schema_meta WHERE key = 'consolidation_last_run'")
      .get() as { value: string } | undefined;
    return row ? Number(row.value) : null;
  }

  private setLastRun(timestamp: number): void {
    this.storage.conn.db
      .prepare("INSERT INTO schema_meta (key, value) VALUES ('consolidation_last_run', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(String(timestamp));
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd bot && npx vitest run tests/memoryConsolidator.test.ts`
Expected: All 4 tests pass

- [ ] **Step 5: Run full test suite**

Run: `cd bot && npx vitest run`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add bot/src/memoryConsolidator.ts bot/tests/memoryConsolidator.test.ts
git commit -m "feat: add MemoryConsolidator for daily memory maintenance

Runs once daily at 3am AEDT. Reviews all dossiers/memories per group,
merges duplicates, trims stale info, and stores a daily conversation
summary as __daily:YYYY-MM-DD memory topic. Keeps last 14 dailies."
```

---

## Task 5: Wire MemoryConsolidator into Index

**Files:**
- Modify: `bot/src/index.ts`

- [ ] **Step 1: Add consolidation to the maintenance loop**

In `bot/src/index.ts`:

1. Add imports:
```typescript
import { MemoryConsolidator, consolidationLimiter } from './memoryConsolidator';
```

2. After creating `memoryExtractor`, create the consolidator:
```typescript
const memoryConsolidator = new MemoryConsolidator(storage, config.timezone);
```

3. In the shutdown handler, add:
```typescript
consolidationLimiter.killAll();
```

4. In the maintenance loop (inside the `if (now - lastReminderCheck >= REMINDER_CHECK_MS)` block, after `messageHandler.runMaintenance()`), add:
```typescript
// Check for daily consolidation
try {
  await memoryConsolidator.runIfDue();
} catch (error) {
  logger.error('Daily consolidation check failed:', error);
}
```

- [ ] **Step 2: Run all tests**

Run: `cd bot && npx vitest run`
Expected: All pass

- [ ] **Step 3: Commit**

```bash
git add bot/src/index.ts
git commit -m "feat: wire consolidation into maintenance loop

Daily consolidation runs during the 30s maintenance cycle,
gated by a daily timestamp check in schema_meta."
```

---

## Task 6: Final Verification

- [ ] **Step 1: Run full test suite**

Run: `cd bot && npx vitest run`
Expected: All pass

- [ ] **Step 2: Run lint**

Run: `cd bot && npm run check`
Expected: Clean

- [ ] **Step 3: Manual smoke test with mock server**

```bash
# Terminal 1:
cd bot && npm run mock-signal

# Terminal 2:
cd bot && npm run dev:mock
```

In the mock server terminal, type: `claude: My name is TestUser and I love hiking`

Verify in logs:
- Bot responds normally
- ~5s later, extraction fires
- Extraction log shows update applied

Check the database:
```bash
cd bot && npx tsx -e "
const Database = require('better-sqlite3');
const db = new Database('./data/mock-bot.db', { readonly: true });
console.log(db.prepare('SELECT * FROM dossiers WHERE groupId LIKE \"%\"').all());
console.log(db.prepare('SELECT * FROM memories WHERE groupId LIKE \"%\"').all());
"
```

- [ ] **Step 4: Final commit with all changes**

If any fixes were needed during smoke testing, commit them.

```bash
git add -A
git commit -m "feat: enhanced memory system - complete implementation

- Background extraction: auto-updates dossiers/memories after each response
- Skills slimming: replaces 4 skill files with condensed capabilities prompt
- Daily consolidation: merges/trims memories, produces daily summaries"
```
