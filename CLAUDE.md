# Signal Family Bot

Claude-powered Signal bot for family group chat. Responds to mention triggers in group chats, powered by Claude CLI with MCP tool servers for reminders and weather.

## Architecture

### Core
- `bot/src/index.ts` — Composition root: wires dependencies, runs polling loop with exponential backoff (auto-reconnects to signal-cli), periodic maintenance every 30s (reminders, message/attachment trimming), WAL checkpoint every 5 min, graceful shutdown (kills child processes, flushes logs)
- `bot/src/messageHandler.ts` — Slim orchestrator: dedup, store, detect mention, build context, invoke LLM, route response. `runMaintenance()` trims messages/attachments for all groups. Store-only groups skip attachment ingestion.
- `bot/src/claudeClient.ts` — Spawns `claude -p` with MCP config from registry. Parses NDJSON/JSON output. Uses `SpawnLimiter` (max 2 concurrent) with SIGKILL escalation on timeout.
- `bot/src/pollingBackoff.ts` — Exponential backoff for polling loop: tracks consecutive errors, calculates delay (`base * 2^errorCount`, capped), triggers reconnection at threshold
- `bot/src/spawnLimiter.ts` — Promise-based semaphore limiting concurrent Claude CLI spawns. Tracks child processes for graceful shutdown (`killAll` with SIGTERM→SIGKILL escalation)
- `bot/src/mentionDetector.ts` — Pure: `isMentioned()`, `extractQuery()`
- `bot/src/contextBuilder.ts` — Builds LLM context: system prompt + history + dossiers + personas + skills
- `bot/src/messageDeduplicator.ts` — Map-based LRU deduplication
- `bot/src/typingIndicator.ts` — `withTyping()` lifecycle wrapper
- `bot/src/reminderScheduler.ts` — Per-group processing, exponential backoff, claim-then-send, failure notifications, recurring reminder orchestration
- `bot/src/recurringReminderExecutor.ts` — Spawns `claude -p` with full MCP config + agents when recurring reminders fire
- `bot/src/signalClient.ts` — JSON-RPC client for signal-cli's HTTP API
- `bot/src/logger.ts` — Async file logging via WriteStream, ANSI-stripped file output, log file rotation (keeps last 10), `close()` for graceful shutdown
- `bot/src/config.ts` — Loads env vars via dotenv

### Storage
- `bot/src/db.ts` — DatabaseConnection: WAL mode, schema migrations via `schema_meta` table, `checkpoint()` for WAL truncation
- `bot/src/storage.ts` — Facade delegating to domain stores (backward compatible), `checkpoint()` for periodic WAL maintenance
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

### Dark Factory Dashboard (`dashboard/`)
- `dashboard/src/server.ts` — HTTP static file server + WebSocket server (port 3333)
- `dashboard/src/watcher.ts` — Chokidar file watcher on `factory/runs/*/`, emits updates on `status.json`, `event.json`, `diary.md` changes
- `dashboard/src/types.ts` — Shared types: Run, StatusFile, EventFile, WsMessage
- `dashboard/public/index.html` — Single-page Preact app (via esm.sh CDN). Real-time pipeline cards with stage progress bars, diary panels, auto-reconnecting WebSocket

Run with `cd dashboard && npm run dev`. Opens at http://localhost:3333. Configure via `DASHBOARD_PORT` and `FACTORY_RUNS_DIR` env vars.

## Running Locally

### Prerequisites

- Claude CLI installed and authenticated (`claude login`)
- Node.js 20+
- Either signal-cli running locally OR use mock mode (see below)
- Plannotator plugin installed (`/plugin install plannotator@plannotator`) — hooks into ExitPlanMode to open an interactive review UI for dark factory human review steps. Requires `~/.local/bin` in PATH (including non-interactive shells for bot-spawned sessions). Env vars: `PLANNOTATOR_REMOTE=1` (remote/SSH, fixed port 19432, no auto-open — avoid concurrent dark factory sessions), `PLANNOTATOR_PORT=<port>`, `PLANNOTATOR_BROWSER=<path>`.

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
- **Signal-cli goes down during operation**: The polling loop auto-reconnects with exponential backoff (2s → 4s → 8s → ... → 60s max). After every 5 consecutive failures, it calls `waitForReady()` to re-establish the connection. Check logs for "Attempting signal-cli reconnection..." messages.
- **Log files**: Written to `logs/` at the repo root. Old log files beyond 10 are cleaned up automatically on startup. Logs use async writes via WriteStream.
- **Orphaned Claude processes on shutdown**: The bot tracks all spawned `claude -p` processes. On SIGINT/SIGTERM, it sends SIGTERM to all children, waits 2s, then exits. Timed-out children also get SIGKILL escalation after 5s.

## Deployment (NUC Production Server)

### Architecture
- **Development (this PC)**: Runs `npm run dev:test` with `--test-channel-only`. Only responds in the Bot Test group; stores messages from all other groups silently.
- **Production (NUC at 192.168.0.239)**: Runs via systemd services. Uses `EXCLUDE_GROUP_IDS` to ignore the Bot Test group. Responds in all real groups.
- Both instances share the same Signal phone number via signal-cli. Channel filtering ensures they don't produce duplicate responses — the group sets are disjoint.

### NUC Services
- `signal-cli.service` — signal-cli native binary, JSON-RPC daemon on port 8080
- `signal-bot.service` — The bot (`npx tsx src/index.ts`), auto-restarts on failure
- `signal-bot-dashboard.service` — Dark Factory dashboard on port 3333

Service templates are in `scripts/systemd/` for reference. To install/update on NUC:
```bash
scp scripts/systemd/*.service zknowles@192.168.0.239:/tmp/
ssh zknowles@192.168.0.239 "sudo cp /tmp/*.service /etc/systemd/system/ && sudo systemctl daemon-reload"
```

### NUC .env Differences
The NUC has its own `bot/.env` with:
- `EXCLUDE_GROUP_IDS=kKWs+FQPBZKe7N7CdxMjNAAjE2uWEmtBij55MOfWFU4=` (test group excluded)
- `SIGNAL_CLI_URL=http://localhost:8080`
- `ATTACHMENTS_DIR=/home/zknowles/signal-bot/data/signal-attachments`
- No `DARK_FACTORY_ENABLED` (production bot only)

### Channel Filtering
- `--test-channel-only` / `TEST_CHANNEL_ONLY=true`: Only respond in the test group (dev mode)
- `EXCLUDE_GROUP_IDS=id1,id2`: Comma-separated group IDs to ignore (production mode). Messages are still stored but LLM processing is skipped.

### Deploying
```bash
./scripts/deploy-nuc.sh                          # deploy current source to NUC
NUC_HOST=10.0.0.5 ./scripts/deploy-nuc.sh       # custom NUC IP
```
Syncs source via rsync (excludes data/.env/node_modules), runs `npm install` if package.json changed, restarts `signal-bot` service.

### Health Check
```bash
./scripts/nuc-health.sh        # default 20 log lines
./scripts/nuc-health.sh 50     # more log lines
```
Checks system resources, service status, signal-cli API, and recent logs.

### Dashboard
Access at http://192.168.0.239:3333 from any device on the local network.

### Manual Operations
```bash
ssh zknowles@192.168.0.239                                           # SSH into NUC
ssh zknowles@192.168.0.239 "journalctl -u signal-bot -f"            # live logs
ssh zknowles@192.168.0.239 "sudo systemctl restart signal-bot"      # restart bot
ssh zknowles@192.168.0.239 "sudo systemctl restart signal-cli"      # restart signal-cli
```

## Testing

```bash
cd bot
npm test              # Run all tests (vitest watch mode)
npx vitest run        # Single run
npm run lint          # Biome lint
npm run check         # Biome lint + format check
```
