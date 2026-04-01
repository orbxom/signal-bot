# Versatile Memory System

**Date:** 2026-04-01
**Replaces:** Current `memories` table + MCP server

## Overview

Replace the existing rigid topic→content memory system with a flexible, taggable knowledge store. The bot can store anything — facts, URLs, images (by reference), preferences — with free-text types, descriptions, and tags. A haiku subagent pipeline handles routine memory reads/writes cheaply, so every conversation benefits from memory context without burning the main model's turn budget.

## Schema

### `memories` table (replaces existing)

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | Auto-increment |
| `groupId` | TEXT NOT NULL | Scoped per group |
| `title` | TEXT NOT NULL | Short label (replaces `topic`) |
| `description` | TEXT | Why this was saved, what it means |
| `content` | TEXT | The actual payload — text, URL, attachment ref, etc. |
| `type` | TEXT NOT NULL | Free-text, bot-managed (e.g. `fact`, `url`, `image`, `preference`) |
| `createdAt` | INTEGER NOT NULL | Epoch ms |
| `updatedAt` | INTEGER NOT NULL | Epoch ms |

Indexes:
- `idx_memories_group` on `(groupId)`
- `idx_memories_group_type` on `(groupId, type)`
- `idx_memories_group_title` unique on `(groupId, title)`

### `memory_tags` join table (new)

| Column | Type | Notes |
|--------|------|-------|
| `memoryId` | INTEGER NOT NULL | FK → memories.id, ON DELETE CASCADE |
| `tag` | TEXT NOT NULL | Lowercase, trimmed |

Indexes:
- Unique on `(memoryId, tag)`
- Index on `tag` for tag-based search

### Migration (V10)

1. Create new `memories_new` table with the new schema
2. Copy existing memories: `topic` → `title`, `content` → `content`, `type` = `'text'`, `description` = NULL
3. Drop old `memories` table, rename `memories_new` to `memories`
4. Create `memory_tags` table
5. Create indexes

## MCP Tools

The memory MCP server is replaced with these 8 tools:

### `save_memory`
Create a new memory. Inputs: `title`, `description`, `content`, `type`, `tags` (string array). Returns the saved memory with token counts for description and content (soft limit feedback). Normalizes type and tags (lowercase, trimmed).

### `update_memory`
Update an existing memory by `id`. All fields optional except `id`. Tags are replaced entirely if provided. Reports token counts.

### `get_memory`
Get a single memory by `id`. Returns all fields + tags.

### `search_memories`
Query tool with optional filters: `tag`, `type`, `keyword` (searches title/description/content via LIKE). Returns matching memories with tags, sorted by `updatedAt` DESC. Default limit 20. With no filters, returns all memories for the group (paginated).

### `list_types`
Returns all distinct `type` values in use for this group. The bot should call this before saving to stay consistent with existing types.

### `list_tags`
Returns all distinct tags in use for this group. Same consistency purpose.

### `delete_memory`
Delete by `id`. Cascading delete removes tag associations.

### `manage_tags`
Add or remove tags from an existing memory. Inputs: `id`, `add` (string array), `remove` (string array). Tags normalized on write.

## Memory CLI Scripts

Thin CLI wrappers around `MemoryStore` for use by haiku subagents via Bash. These are NOT MCP servers — they read/write the same SQLite DB directly and output plain text.

Location: `bot/src/memory/cli.ts`

Single entry point with subcommands:
- `npx tsx src/memory/cli.ts search --group <id> [--keyword <kw>] [--tag <tag>] [--type <type>]`
- `npx tsx src/memory/cli.ts save --group <id> --title <t> --type <type> [--description <d>] [--content <c>] [--tags <t1,t2>]`
- `npx tsx src/memory/cli.ts list-types --group <id>`
- `npx tsx src/memory/cli.ts list-tags --group <id>`
- `npx tsx src/memory/cli.ts delete --group <id> --id <memoryId>`

Output is plain text, human-readable (not JSON), easy for haiku to parse.

## Haiku Subagent Pipeline

### Pre-response (synchronous)

In `messageHandler.ts`, before the main Claude invocation:

1. Spawn `claude -p --model haiku` with:
   - The incoming message text
   - Instructions to search the group's memories for anything relevant
   - Access to memory CLI scripts via Bash
2. Haiku searches memories (by keyword extraction from the message), returns a plain-text summary
3. Summary is injected into the main Claude's context via `contextBuilder.ts` as a "Relevant memories" section
4. If haiku returns nothing relevant, no section is injected

**Timeout:** 10 seconds. If haiku doesn't respond in time, skip memory context and proceed without it.

**Cost:** Haiku is cheap. This runs on every message where the bot is mentioned, which is the same trigger as the main Claude call.

### Post-response (async, fire-and-forget)

After the main Claude responds and the response is sent:

1. Spawn `claude -p --model haiku` in the background with:
   - The incoming message + bot response
   - Instructions to extract anything worth remembering
   - Instructions to check existing types/tags for consistency before saving
   - Access to memory CLI scripts via Bash
2. Haiku decides what to save, writes via CLI scripts
3. Process exits when done — no waiting, no error propagation to the user

**What to save:** New facts about people, preferences mentioned, URLs shared, corrections to known info, notable events. Haiku is instructed to be aggressive but not redundant — check existing memories before duplicating.

## Normalization

- **Tags:** Lowercased, trimmed, whitespace collapsed. Duplicates silently ignored on write.
- **Types:** Lowercased, trimmed. No enum enforcement — the bot is trusted to check `list_types` first.
- **Token feedback:** `save_memory` and `update_memory` report approximate token counts for `description` and `content` in their responses. No hard limits enforced.

## Integration Points

### contextBuilder.ts
Add an optional `memorySummary` parameter. When present, inject a "## Relevant Memories" section into the system prompt after dossiers. The haiku pre-response step provides this.

### messageHandler.ts
- Before main Claude call: spawn haiku memory reader, collect summary
- After main Claude response: spawn haiku memory writer in background
- Both use `SpawnLimiter` for process management

### storage.ts
Add `MemoryStore` delegation methods for the new schema (title, description, content, type, tags).

### types.ts
Update `Memory` interface to include `description`, `type`, rename `topic` to `title`. Add `MemoryTag` interface.

## What Doesn't Change

- `contextBuilder.ts` core structure — memories are additive context, not a replacement
- Other MCP servers — unaffected
- `registry.ts` — memory server stays in `ALL_SERVERS`, just updated tools
- `db.ts` migration pattern — new migration V10
