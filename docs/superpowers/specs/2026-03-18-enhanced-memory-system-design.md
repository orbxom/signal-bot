# Enhanced Memory System

## Problem

The bot's memory is passive — dossiers and group memories only update when explicitly asked. After 9 days of silence, the bot greeted a known family member as a stranger despite having their dossier loaded. The context window is also severely constrained: skill files consume 48% of the 4,000-token budget, leaving ~5-15 messages of chat history.

## Goals

1. **Automatic memory extraction** — Bot silently updates dossiers and memories after every interaction
2. **More context for conversations** — Free up token budget by slimming skill overhead
3. **Memory maintenance** — Daily consolidation to keep memories concise and current, plus daily conversation summaries

## Non-Goals

- Mood/tone tracking per person
- Semantic/vector search (staying with SQLite keyword search)
- Third-party memory service integration (Mem0, Zep, etc.)
- Changes to message retention or archival (existing 1000/group + search tools are sufficient)

---

## Feature 1: Background Memory Extraction

### Overview

After every bot response, fire a non-blocking background job that reviews the recent conversation against current dossiers/memories and produces structured updates.

### Flow

```
Bot sends response to Signal group
  → messageHandler stores bot response (existing)
  → messageHandler fires backgroundExtract(groupId) (new, non-blocking)
      → Fetch last 20 messages for the group
      → Fetch all dossiers for the group
      → Fetch all memories for the group
      → Build extraction prompt with this context
      → Spawn lightweight `claude -p` (no MCP tools, JSON output)
      → Parse JSON response
      → Apply dossier upserts and memory upserts/deletes to DB
      → Log changes (no announcement to group chat)
```

### Extraction Prompt

A focused system prompt (~500 tokens) that instructs Claude to:

- Compare the recent messages against existing dossiers and memories
- Output a JSON object with any updates needed
- Only produce updates when there's genuinely new information
- Never repeat what's already captured
- Use ADD for new entries, UPDATE for changed facts, DELETE for contradicted/stale info
- For dossiers: preserve existing notes and append new facts (not replace)
- For memories: replace content for existing topics, create new topics as needed

### JSON Output Schema

```json
{
  "dossierUpdates": [
    {
      "action": "update",
      "personId": "uuid-or-phone",
      "displayName": "Glen",
      "notes": "full updated notes for this person"
    }
  ],
  "memoryUpdates": [
    {
      "action": "add",
      "topic": "easter plans",
      "content": "Family going to Byron Bay for Easter 2026"
    },
    {
      "action": "delete",
      "topic": "old-topic"
    }
  ]
}
```

### Concurrency & Lifecycle

- Uses its own `SpawnLimiter(1)` instance — separate from the response limiter but **registered with the shutdown handler** in `index.ts` so extraction processes are killed on graceful shutdown (avoids orphaned `claude -p` processes)
- Max 1 extraction running at a time
- **Debounced**: After a bot response, wait 5 seconds before firing extraction. If another response arrives during the wait, reset the timer. This way a burst of 10 rapid messages triggers one extraction at the end, not 10.
- Extraction failures are logged but never surface to the group

### Dossier Update Semantics

Claude outputs the **complete merged notes** for each dossier update — i.e., it reads the existing notes, decides what to keep/add/remove, and outputs the full replacement text. The extraction code does a simple `upsert()` with the result. Claude is not outputting "just the new facts to append" — it owns the merge.

### Implementation Details

- New file: `bot/src/memoryExtractor.ts` — encapsulates the extraction logic
- Spawns `claude -p` directly (same pattern as `recurringReminderExecutor.ts` but without MCP config)
- Uses a dedicated `SpawnLimiter(1)` registered with the shutdown handler
- Model: Uses default Claude CLI model (Haiku via config)
- Only triggers for groups where the bot actually responded (not store-only groups)
- Timeout: 30s hard kill

---

## Feature 2: Skills Slimming

### Overview

Replace the 4 separate skill markdown files (~1,934 tokens loaded every request) with a condensed guidance section in the system prompt (~300-500 tokens).

### Current Skills (to be removed as separate files)

- `dossier-maintenance.md` — When/how to update dossiers
- `memory-maintenance.md` — When/how to save group memories
- `persona-management.md` — How personas work
- `feature-requests.md` — How to file feature requests

### Replacement

Add a concise "Capabilities" section to the system prompt that tells Claude:

- You have dossier tools (update_dossier, get_dossier, list_dossiers) for person-specific info
- You have memory tools (save_memory, get_memory, list_memories, delete_memory) for group facts
- You have persona tools for switching personalities
- You can search message history and view images
- You can file feature requests via GitHub tools

This is reference info, not behavioral instructions — the background extractor now handles the proactive memory updates that the skill files were coaching Claude to do manually.

### Implementation

- Edit `bot/src/contextBuilder.ts` — add condensed capabilities text as a constant
- Edit `bot/src/messageHandler.ts` — remove `loadSkillContent()` call from `assembleAdditionalContext()`
- Delete or archive `bot/src/skills/*.md` files
- Net savings: ~1,400+ tokens freed for chat history

---

## Feature 3: Daily Consolidation + Summaries

### Overview

A daily maintenance job that reviews and consolidates all dossiers and memories per group, and produces a brief daily conversation summary.

### Schedule

- Runs once per day at 3:00 AM AEDT
- Integrated into the existing polling/maintenance loop in `index.ts` with a daily timestamp check
- Persists last-run timestamp in `schema_meta` table to survive restarts

### Per-Group Consolidation Flow

```
For each group with messages in the last 24 hours:
  → Fetch all dossiers for the group
  → Fetch all memories for the group
  → Fetch all messages from the last 24 hours
  → Spawn Claude with consolidation prompt
  → Parse JSON response
  → Apply dossier rewrites (trimmed, merged, deduplicated)
  → Apply memory rewrites (merged, stale removed)
  → Store daily summary as memory topic "daily:YYYY-MM-DD"
```

### Consolidation Prompt

Instructs Claude to:

- Review all dossiers: merge duplicate facts, remove stale info, rewrite for conciseness
- Review all memories: merge related topics, remove outdated entries
- Produce a brief daily summary (2-3 sentences) of the day's conversations
- Output as JSON with the same schema as the extraction prompt

### Daily Summaries

- Stored as memory topics with prefix `__daily:` (e.g., `__daily:2026-03-18`) — double-underscore prefix prevents clashes with user-created topics
- Content: Brief recap — who was active, what was discussed, any notable events
- Retention: Keep last 14 daily summaries. Older ones are auto-deleted during consolidation.
- These summaries are loaded into context like any other memory, giving the bot a sense of recent history

### Implementation

- New file: `bot/src/memoryConsolidator.ts` — consolidation logic
- Edit `bot/src/index.ts` — add daily check to maintenance loop
- Add `consolidation_last_run` key to `schema_meta` table
- Reuses the same JSON schema and DB application logic as the extraction feature
- All writes for a single group wrapped in a `db.transaction()` for atomicity
- If the bot was down when consolidation was due, run it on next startup (catch-up)
- Message input for the consolidation Claude call is token-bounded (max 4000 tokens of messages, same pattern as `fitToTokenBudget()`)

---

## Token Budget Impact

Budget is 10,000 tokens (recently increased from 4,000).

### Before (10,000 tokens, with skills)

| Component | Tokens | % |
|-----------|--------|---|
| System prompt + instructions | ~450 | 5% |
| Skills | ~1,934 | 19% |
| Dossiers (5 people) | ~250 | 3% |
| Memories (3 topics) | ~800 | 8% |
| **Chat history** | **~6,566** | **66%** |

### After (10,000 tokens, skills slimmed)

| Component | Tokens | % |
|-----------|--------|---|
| System prompt + capabilities | ~600 | 6% |
| Dossiers (5 people) | ~250 | 3% |
| Memories (5 topics + dailies) | ~1,200 | 12% |
| **Chat history** | **~7,950** | **80%** |

Skills slimming frees ~1,400 tokens. Chat history improves from ~80-100 messages to ~100-120 messages. The big win was the budget increase from 4k to 10k (already done).

---

## Files to Create/Modify

### New Files
- `bot/src/memoryExtractor.ts` — Background extraction logic
- `bot/src/memoryConsolidator.ts` — Daily consolidation logic

### Modified Files
- `bot/src/messageHandler.ts` — Fire extraction after response, remove `loadSkillContent()` call from `assembleAdditionalContext()`
- `bot/src/contextBuilder.ts` — Remove `loadSkillContent()` method and `cachedSkillContent` field. Add condensed capabilities text. Audit existing inline constants (`SOURCE_CODE_INSTRUCTIONS`, `MEMORY_INSTRUCTIONS`, `VOICE_MESSAGE_INSTRUCTIONS`, `IMAGE_INSTRUCTIONS`) to avoid duplication with the new capabilities section.
- `bot/src/index.ts` — Add daily consolidation check to maintenance loop, register extraction SpawnLimiter with shutdown handler

### Deleted/Archived
- `bot/src/skills/dossier-maintenance.md`
- `bot/src/skills/memory-maintenance.md`
- `bot/src/skills/persona-management.md`
- `bot/src/skills/feature-requests.md`

---

## Testing

1. **Unit tests** for `memoryExtractor.ts`:
   - Correctly parses valid JSON from Claude
   - Handles malformed/empty responses gracefully
   - Applies dossier upserts correctly
   - Applies memory add/update/delete correctly
   - Respects concurrency limit (drops when busy)
   - Times out after 30s

2. **Unit tests** for `memoryConsolidator.ts`:
   - Runs only when due (respects daily schedule)
   - Processes only active groups
   - Stores daily summary with correct topic format
   - Trims old daily summaries (>14 days)
   - Handles empty groups gracefully

3. **Integration test** via mock server:
   - Send messages, trigger bot response
   - Verify extraction fires and updates DB
   - Verify dossiers/memories reflect new info

4. **Context size verification**:
   - Log token allocation breakdown per request
   - Verify skills removal saves expected tokens
   - Verify chat history depth improves

---

## Verification

- Send a message to the bot mentioning a new fact about yourself
- Check the database — dossier should auto-update within ~10s without the bot announcing it
- Next day at 3am, verify consolidation ran (check logs + `schema_meta` for timestamp)
- Verify daily summary appears as a `__daily:YYYY-MM-DD` memory topic
- Compare conversation quality — bot should reference more recent context in responses
