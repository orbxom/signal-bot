# Stable/Experimental MCP Server Split

## Problem

All MCP tool servers are always loaded regardless of environment. New or in-development servers (e.g., `darkFactory`, `notableDates`) should only be available in dev mode, not on the production NUC. There's no mechanism to gate servers by environment.

## Approach

Split the `ALL_SERVERS` array in `bot/src/mcp/servers/index.ts` into two arrays — `STABLE_SERVERS` and `EXPERIMENTAL_SERVERS` — and compose them at runtime based on the `INCLUDE_EXPERIMENTAL` env var.

## Server Classification

**Stable (production + dev):**
- github, reminders, dossiers, images, memories, messageHistory, weather, sourceCode, settings, signal, personas

**Experimental (dev-only):**
- darkFactory, notableDates

**External (always included, unchanged):**
- transcription, playwright

## Changes

### `bot/src/mcp/servers/index.ts`

Replace the single `ALL_SERVERS` export with:

- `STABLE_SERVERS: McpServerDefinition[]` — production-ready servers
- `EXPERIMENTAL_SERVERS: McpServerDefinition[]` — dev-only servers
- `getActiveServers(): McpServerDefinition[]` — returns stable-only or stable+experimental based on `process.env.INCLUDE_EXPERIMENTAL === 'true'`
- Keep `ALL_SERVERS` as a convenience export (`[...STABLE_SERVERS, ...EXPERIMENTAL_SERVERS]`) for tests and diagnostics

### `bot/src/mcp/registry.ts`

- Change import from `ALL_SERVERS` to `getActiveServers`
- `buildAllowedTools()`: call `getActiveServers()` instead of using `ALL_SERVERS`
- `buildMcpConfig()`: iterate `getActiveServers()` instead of `ALL_SERVERS`
- `EXTERNAL_SERVERS` block unchanged — transcription and playwright are always included

### `bot/src/mcp/servers/healthCheck.ts`

- Switch lazy require from `ALL_SERVERS` to `getActiveServers` so health check reports actually-active server count (it lazy-requires `./index` at runtime)

### `bot/tests/mcp/registry.test.ts`

- Update import from `ALL_SERVERS` (still exported as convenience alias, so no functional change needed — but verify tests pass)

### `bot/src/index.ts`

- Import `STABLE_SERVERS` and `EXPERIMENTAL_SERVERS` from the barrel
- Add startup log line showing active server count with breakdown, e.g. `"MCP servers: 13 active (11 stable + 2 experimental)"` or `"MCP servers: 11 active (stable only)"`

### `bot/.env`

- Add `INCLUDE_EXPERIMENTAL=true` to the local dev `.env`
- NUC `.env` does not set this variable — defaults to stable-only

### `CLAUDE.md`

- Update the `servers/index.ts` description to reference `STABLE_SERVERS`, `EXPERIMENTAL_SERVERS`, and `getActiveServers()` instead of `ALL_SERVERS`

## Caching

`buildAllowedTools()` is cached once in `claudeClient.ts` via `getAllowedTools()`. `recurringReminderExecutor.ts` calls `buildAllowedTools()` directly (uncached) on each recurring reminder execution. Both are correct since `INCLUDE_EXPERIMENTAL` is set at process startup and `getActiveServers()` reads the same env var each time.

## Promotion Workflow

To promote a server from experimental to stable:

1. Move its import line from `EXPERIMENTAL_SERVERS` to `STABLE_SERVERS` in `bot/src/mcp/servers/index.ts`
2. Commit and deploy

One-line change, no other files affected.

## What Doesn't Change

- `McpServerDefinition` interface — no new fields
- Individual server files — no modifications
- `claudeClient.ts` — calls `buildAllowedTools()` and `buildMcpConfig()` as before
- `recurringReminderExecutor.ts` — same
- External servers — transcription and playwright handling untouched
- `healthCheck.ts` — not in `ALL_SERVERS` (standalone MCP server, not registered in barrel), out of scope
- Existing tests — `registry.test.ts` imports `ALL_SERVERS` which remains as a convenience export
