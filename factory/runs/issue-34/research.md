# Research: Dark Factory MCP Tools (Issue #34)

## Codebase Analysis

### MCP Server Pattern
- Follow `bot/src/mcp/servers/github.ts` exactly: `execFileAsync`, `catchErrors`, `requireString/Number`, `ok/error`
- Register in `bot/src/mcp/servers/index.ts` barrel file — auto-discovered by registry
- Tool IDs become `mcp__darkFactory__start_dark_factory` and `mcp__darkFactory__read_dark_factory`
- Handlers can be async (return `Promise<ToolResult>`)
- Test pattern: `bot/tests/helpers/mcpTestHelpers.ts` — `spawnMcpServer()`, `sendAndReceive()`, `initializeServer()`

### Key Imports
```typescript
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { catchErrors, error, ok } from '../result';
import { runServer } from '../runServer';
import type { McpServerDefinition } from '../types';
import { requireNumber, requireString } from '../validate';
```

### No envMapping Needed
- Paths derived from `os.homedir()` — no MessageContext fields required
- `envMapping: {}` is valid

## Kitty Remote Control

- `kitty @ launch --type=os-window [-- CMD]` — opens new OS window, returns window ID, **does not block**
- Requires `allow_remote_control yes` in `kitty.conf`
- Can pass `--title`, `--cwd`, `--hold`, `--env`

## Zellij Sessions

- `zellij attach <name> --create` — creates/attaches named session
- **CRITICAL: Does NOT support trailing `--` for initial command**
- `zellij -s <name>` — sets session name on startup
- **Solution: Use KDL layout file** to specify initial pane command:
  ```kdl
  layout {
      pane command="bash" {
          args "-c" "cd /path && claude \"dark factory issue 42\""
          close_on_exit false
      }
  }
  ```
- Launch: `kitty @ launch --type=os-window -- zellij -s <name> --layout /tmp/layout.kdl`

## Claude CLI

- `claude "query"` — starts interactive REPL with initial prompt (blocks, interactive)
- `claude -p "query"` — non-interactive, prints and exits
- We want interactive mode so user can watch/intervene

## JSONL Conversation Files

- Location: `~/.claude/projects/-home-zknowles-personal-signal-bot/<uuid>.jsonl`
- Format: NDJSON, one JSON object per line
- Key entry types:
  - `type: "assistant"` — LLM responses with `message.content[]` (text, tool_use, thinking blocks)
  - `type: "user"` — user messages with `message.content`
  - `type: "progress"` — hooks, agent progress
  - `type: "file-history-snapshot"` — file state tracking
- Common fields: `uuid`, `parentUuid`, `timestamp`, `sessionId`
- Assistant content blocks: `{type: "text", text: "..."}`, `{type: "tool_use", name: "Bash", input: {...}}`

## Related Issues

- **Issue #30** (sandbox permissions) — NOT a blocker. MCP tools run as separate processes with full system access, not inside bot agent sandbox.
- No other conflicts with open issues.

## .gitignore

- `factory/sessions/` NOT currently gitignored — needs to be added
- `factory/runs/` IS tracked (intentional — artifacts checked in)
