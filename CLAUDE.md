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
- `sourceCode.ts` — List/read/search source files (3 tools)
- `messageHistory.ts` — Search and date-range message queries (2 tools)
- `signal.ts` — Send messages and images via Signal (2 tools)
- `personas.ts` — Bot persona CRUD + switching (6 tools)

### Adding a New MCP Server
1. Create `bot/src/mcp/servers/newThing.ts` using shared `ok()`, `error()`, `requireString()`, etc.
2. Add one import line to `bot/src/mcp/servers/index.ts`
No other files need to change.

## Running Locally for Testing

### Prerequisites

- signal-cli must be running locally (handles Signal protocol)
- Claude CLI installed and authenticated (`claude login`)
- Node.js 20+

### Steps

1. Ensure `.env` exists in the project root with at least `BOT_PHONE_NUMBER` set:
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

## Testing

```bash
cd bot
npm test              # Run all tests (vitest watch mode)
npx vitest run        # Single run
npm run lint          # Biome lint
npm run check         # Biome lint + format check
```
