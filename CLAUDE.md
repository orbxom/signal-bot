# Signal Family Bot

Claude-powered Signal bot for family group chat. Responds to mention triggers in group chats, powered by Claude CLI with MCP tool servers for reminders and weather.

## Architecture

### Core
- `bot/src/index.ts` — Composition root: wires dependencies, runs polling loop, checks reminders every 30s
- `bot/src/messageHandler.ts` — Slim orchestrator: dedup, store, detect mention, build context, invoke LLM, route response
- `bot/src/claudeClient.ts` — Spawns `claude -p` with MCP config from registry. Parses NDJSON/JSON output
- `bot/src/mentionDetector.ts` — Pure: `isMentioned()`, `extractQuery()`
- `bot/src/contextBuilder.ts` — Builds LLM context: system prompt + history + dossiers + personas + skills
- `bot/src/messageDeduplicator.ts` — Map-based LRU deduplication
- `bot/src/typingIndicator.ts` — `withTyping()` lifecycle wrapper
- `bot/src/reminderScheduler.ts` — Per-group processing, exponential backoff, claim-then-send, failure notifications, recurring reminder orchestration
- `bot/src/recurringReminderExecutor.ts` — Spawns `claude -p` with full MCP config + agents when recurring reminders fire
- `bot/src/signalClient.ts` — JSON-RPC client for signal-cli's HTTP API
- `bot/src/config.ts` — Loads env vars via dotenv

### Storage
- `bot/src/db.ts` — DatabaseConnection: WAL mode, schema migrations via `schema_meta` table
- `bot/src/storage.ts` — Facade delegating to domain stores (backward compatible)
- `bot/src/stores/messageStore.ts` — Message CRUD, search, date range queries
- `bot/src/stores/reminderStore.ts` — Per-group reminders with idempotent markSent, retry tracking
- `bot/src/stores/recurringReminderStore.ts` — Recurring reminders with cron scheduling, in-flight guards, failure tracking
- `bot/src/stores/dossierStore.ts` — Person dossiers scoped by group
- `bot/src/stores/personaStore.ts` — Bot personas with active-per-group management
- `bot/src/stores/attachmentStore.ts` — Image attachment BLOB storage and cleanup

### Image Attachments
Image attachments sent in Signal messages are stored as BLOBs in the `attachment_data` SQLite table on receipt. Conversation context references them as `[Image: attachment://<id>]`. Claude uses the `view_image` MCP tool to retrieve and view images from the DB.

### MCP Framework
- `bot/src/mcp/types.ts` — McpServerDefinition, ToolDefinition, ToolHandler interfaces
- `bot/src/mcp/result.ts` — `ok()`, `error()`, `catchErrors()`, `getErrorMessage()`, `estimateTokens()`
- `bot/src/mcp/validate.ts` — `requireString()`, `requireNumber()`, `requireGroupId()`, `optionalString()`
- `bot/src/mcp/env.ts` — `readStorageEnv()`, `readTimezone()`
- `bot/src/mcp/runServer.ts` — MCP JSON-RPC protocol handler (stdin/stdout)
- `bot/src/mcp/registry.ts` — `buildAllowedTools()`, `buildMcpConfig()` — auto-discovers servers from registry

### MCP Servers (bot/src/mcp/servers/)
- `index.ts` — Barrel: ALL_SERVERS array (add new server = add one import here)
- `reminders.ts` — set/list/cancel reminders + set/list/cancel recurring reminders (6 tools)
- `weather.ts` — BOM weather: search, observations, forecast, warnings (4 tools)
- `github.ts` — GitHub integration: feature request issues, PR list/view/diff/comment/review/merge (7 tools)
- `dossiers.ts` — Person dossier CRUD (3 tools)
- `sourceCode.ts` — List/read/search source files (3 tools). Paths are relative to `bot/`, not the repo root (e.g., use `src/index.ts` not `bot/src/index.ts`)
- `messageHistory.ts` — Search and date-range message queries (2 tools)
- `signal.ts` — Send messages and images via Signal (2 tools)
- `images.ts` — View image attachments stored in DB (1 tool)
- `personas.ts` — Bot persona CRUD + switching (6 tools)

### Adding a New MCP Server
1. Create `bot/src/mcp/servers/newThing.ts` using shared `ok()`, `error()`, `requireString()`, etc.
2. Set `entrypoint` to just the filename without path: `entrypoint: 'newThing'` (NOT `'mcp/servers/newThing'`). The registry prepends `servers/` and resolves relative to `bot/src/mcp/`.
3. Add one import line to `bot/src/mcp/servers/index.ts`
No other files need to change.

## Running Locally

### Prerequisites

- Claude CLI installed and authenticated (`claude login`)
- Node.js 20+
- Either signal-cli running locally OR use mock mode (see below)

### Test Mode (real Signal, Bot Test group only)

Requires signal-cli running locally. Restricts the bot to the "Bot Test" group only to prevent spamming the family group.

1. Ensure signal-cli is running and `bot/.env` exists (dotenv loads from CWD, which is `bot/`):
   ```bash
   # bot/.env
   BOT_PHONE_NUMBER=+61XXXXXXXXXX
   SIGNAL_CLI_URL=http://localhost:8080
   MENTION_TRIGGERS="@bot,bot:,@claude,claude:,c "
   CLAUDE_MAX_TURNS=25
   ```
   **Important:** The `c ` trigger has a trailing space. Dotenv strips trailing whitespace from unquoted values, so the `MENTION_TRIGGERS` value **must be quoted** to preserve it.

2. Run:
   ```bash
   cd bot
   SIGNAL_CLI_URL=http://localhost:8080 npm run dev:test
   ```

   Note: `npm run dev:test` defaults `SIGNAL_CLI_URL` to port 9090 (mock). You must explicitly set port 8080 when using real signal-cli.

3. Send a message starting with the mention trigger (e.g. `claude: hello`) in the Bot Test Signal group.

Use `npm run dev` for all channels (only if specifically needed).

### Mock Mode (no Signal access needed)

Uses a mock signal-cli HTTP server (`bot/src/mock/signalServer.ts`) so you can test the bot from the CLI without Signal. Uses the `mock-signal-testing` skill for setup guidance.

**In two terminals:**

```bash
# Terminal 1: Start the mock signal-cli server
cd bot
npm run mock-signal                    # Listens on port 9090 by default

# Terminal 2: Start the bot pointed at the mock server
cd bot
npm run dev:mock                       # Separate DB (data/mock-bot.db), port 9090
```

Use `npm run dev:mock` instead of `npm run dev:test` so the mock bot uses a separate database (`data/mock-bot.db`). This lets you run mock testing **alongside** the real bot (`dev:test` on port 8080) without SQLite conflicts.

If you only need mock testing (no real bot running), `npm run dev:test` also works — it defaults to port 9090 but shares the main database.

**Sending messages:** Type in the mock server terminal. Prefix with `claude:` to trigger the bot.

```
you> claude: what is 2+2?
[QUEUED] "claude: what is 2+2?"
[TYPING...]
[BOT] 4!
```

**Mock commands:** `/help`, `/clear` (empty queue), `/quit`.

The mock server hardcodes the Bot Test group and sender `+61400111222`. The bot requires no code changes — it connects to the mock via the same JSON-RPC API it uses with real signal-cli.

### Collaborative Testing Mode

When running via `npm run dev:mock` (or with `COLLABORATIVE_TESTING=true`), the bot injects a **collaborative testing mode** section into its system prompt. This tells the inner Claude that it's being tested by another Claude instance and should:

- Respond technically and precisely, not with casual family-chat tone
- Confirm which tools it called and summarize results
- Report tool errors, MCP failures, or unexpected inputs with full detail
- Explain step-by-step what it did and why

This is designed for the dark factory's integration test stage (Stage 6), where the outer Claude sends test messages and needs precise diagnostic feedback from the bot. Both sides are aware of the collaborative context.

**Note:** `dev:test` does NOT enable this mode — it's for real Signal testing against the test group. Only `dev:mock` (or explicit `COLLABORATIVE_TESTING=true`) activates it.

### Troubleshooting

- **Bot not receiving messages**: The `extractMessageData` method only processes group messages with `dataMessage.message` and `groupInfo.groupId`. DMs and reactions are silently dropped.
- **MCP tools not working**: MCP servers run via `npx tsx` on the `.ts` source files. The `resolveMcpServerPath` helper in `mcp/registry.ts` handles path resolution.
- **Port already in use**: The mock server defaults to port 9090 (to avoid conflicts with real signal-cli on 8080). Use `MOCK_SIGNAL_PORT=XXXX` and `SIGNAL_CLI_URL=http://localhost:XXXX` to change it.

## Testing

```bash
cd bot
npm test              # Run all tests (vitest watch mode)
npx vitest run        # Single run
npm run lint          # Biome lint
npm run check         # Biome lint + format check
```
