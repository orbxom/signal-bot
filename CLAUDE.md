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
- `bot/src/reminderScheduler.ts` — Per-group processing, exponential backoff, claim-then-send, failure notifications
- `bot/src/signalClient.ts` — JSON-RPC client for signal-cli's HTTP API
- `bot/src/config.ts` — Loads env vars via dotenv

### Storage
- `bot/src/db.ts` — DatabaseConnection: WAL mode, schema migrations via `schema_meta` table
- `bot/src/storage.ts` — Facade delegating to domain stores (backward compatible)
- `bot/src/stores/messageStore.ts` — Message CRUD, search, date range queries
- `bot/src/stores/reminderStore.ts` — Per-group reminders with idempotent markSent, retry tracking
- `bot/src/stores/dossierStore.ts` — Person dossiers scoped by group
- `bot/src/stores/personaStore.ts` — Bot personas with active-per-group management

### MCP Framework
- `bot/src/mcp/types.ts` — McpServerDefinition, ToolDefinition, ToolHandler interfaces
- `bot/src/mcp/result.ts` — `ok()`, `error()`, `catchErrors()`, `getErrorMessage()`, `estimateTokens()`
- `bot/src/mcp/validate.ts` — `requireString()`, `requireNumber()`, `requireGroupId()`, `optionalString()`
- `bot/src/mcp/env.ts` — `readStorageEnv()`, `readTimezone()`
- `bot/src/mcp/runServer.ts` — MCP JSON-RPC protocol handler (stdin/stdout)
- `bot/src/mcp/registry.ts` — `buildAllowedTools()`, `buildMcpConfig()` — auto-discovers servers from registry

### MCP Servers (bot/src/mcp/servers/)
- `index.ts` — Barrel: ALL_SERVERS array (add new server = add one import here)
- `reminders.ts` — set/list/cancel reminders (3 tools)
- `weather.ts` — BOM weather: search, observations, forecast, warnings (4 tools)
- `github.ts` — Create GitHub issues from feature requests (1 tool)
- `dossiers.ts` — Person dossier CRUD (3 tools)
- `sourceCode.ts` — List/read/search source files (3 tools). Paths are relative to `bot/`, not the repo root (e.g., use `src/index.ts` not `bot/src/index.ts`)
- `messageHistory.ts` — Search and date-range message queries (2 tools)
- `signal.ts` — Send messages and images via Signal (2 tools)
- `personas.ts` — Bot persona CRUD + switching (6 tools)

### Adding a New MCP Server
1. Create `bot/src/mcp/servers/newThing.ts` using shared `ok()`, `error()`, `requireString()`, etc.
2. Add one import line to `bot/src/mcp/servers/index.ts`
No other files need to change.

## Running Locally for Testing

### Prerequisites

- Claude CLI installed and authenticated (`claude login`)
- Node.js 20+
- Either signal-cli running locally OR use the mock Signal server (see below)

### Mock Signal Server (no Signal access needed)

A mock signal-cli HTTP server (`bot/src/mock/signalServer.ts`) implements the JSON-RPC API so you can test the bot from the CLI without Signal. It uses `node:http` and `node:readline` with no extra dependencies.

**In two terminals:**

```bash
# Terminal 1: Start the mock signal-cli server
cd bot
npm run mock-signal                    # Listens on port 8080 by default
# Or on a custom port:
MOCK_SIGNAL_PORT=9090 npm run mock-signal

# Terminal 2: Start the bot pointed at the mock server
cd bot
npm run dev:test                       # If mock is on default port 8080
# Or if using a custom port:
SIGNAL_CLI_URL=http://localhost:9090 npm run dev:test
```

**Sending messages:** Type in the mock server terminal. Prefix with `claude:` to trigger the bot.

```
you> claude: what is 2+2?
[QUEUED] "claude: what is 2+2?"
[TYPING...]
[BOT] 4!
```

**Mock commands:** `/help`, `/clear` (empty queue), `/quit`.

The mock server hardcodes the Bot Test group and sender `+61400111222`. The bot requires no code changes — it connects to the mock via the same JSON-RPC API it uses with real signal-cli.

### With Real Signal

1. Ensure signal-cli is running locally and `.env` exists in the project root with at least `BOT_PHONE_NUMBER` set:
   ```bash
   # .env
   BOT_PHONE_NUMBER=+61XXXXXXXXXX
   SIGNAL_CLI_URL=http://localhost:8080
   MENTION_TRIGGERS=claude:
   CLAUDE_MAX_TURNS=25
   ```

2. Run the bot in dev mode (hot reload via tsx):
   ```bash
   cd bot
   npm run dev:test    # Test channel only (default for dev — prevents spamming family group)
   npm run dev         # All channels (only if specifically needed)
   ```

   **Always use `npm run dev:test` for local development** unless specifically asked to test against all groups. This restricts the bot to the "Bot Test" group only.

3. Send a message starting with the mention trigger (e.g. `claude: hello`) in the Bot Test Signal group.

### Troubleshooting

- **Bot not receiving messages**: The `extractMessageData` method only processes group messages with `dataMessage.message` and `groupInfo.groupId`. DMs and reactions are silently dropped.
- **MCP tools not working**: MCP servers run via `npx tsx` on the `.ts` source files. The `resolveMcpServerPath` helper in `mcp/registry.ts` handles path resolution.
- **Port already in use**: If port 8080 is taken (e.g. real signal-cli is running), use `MOCK_SIGNAL_PORT=9090` for the mock and `SIGNAL_CLI_URL=http://localhost:9090` for the bot.

## Testing

```bash
cd bot
npm test              # Run all tests (vitest watch mode)
npx vitest run        # Single run
npm run lint          # Biome lint
npm run check         # Biome lint + format check
```
