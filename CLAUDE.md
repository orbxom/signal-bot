# Signal Family Bot

Claude-powered Signal bot for family group chat. Responds to mention triggers in group chats, powered by Claude CLI with MCP tool servers for reminders and weather.

## Architecture

- `bot/src/index.ts` — Main polling loop: receives Signal messages, dispatches to handler, checks due reminders every 30s
- `bot/src/messageHandler.ts` — Detects mention triggers, builds conversation context with system prompt, invokes Claude CLI
- `bot/src/claudeClient.ts` — Spawns `claude -p` with MCP server configs and allowed tools. Parses NDJSON/JSON output
- `bot/src/reminderMcpServer.ts` — MCP server (stdio JSON-RPC) for set/list/cancel reminders. Spawned by Claude CLI as a subprocess
- `bot/src/weatherMcpServer.ts` — MCP server for BOM weather data
- `bot/src/githubMcpServer.ts` — MCP server for creating GitHub issues from feature requests via `gh` CLI
- `bot/src/reminderScheduler.ts` — Polls SQLite for due reminders, sends them to Signal, handles retries
- `bot/src/signalClient.ts` — JSON-RPC client for signal-cli's HTTP API
- `bot/src/storage.ts` — SQLite persistence (messages + reminders)
- `bot/src/config.ts` — Loads env vars via dotenv

## Running Locally for Testing

### Prerequisites

- signal-cli container must be running (handles Signal protocol)
- Claude CLI installed and authenticated (`claude login`)
- Node.js 20+

### Steps

1. Start the signal-cli container (if not already running):
   ```bash
   docker compose up -d signal-cli
   ```

2. Ensure `.env` exists in the project root with at least `BOT_PHONE_NUMBER` set. For local dev, override `SIGNAL_CLI_URL` to point at localhost since signal-cli exposes port 8080:
   ```bash
   # .env
   BOT_PHONE_NUMBER=+61XXXXXXXXXX
   SIGNAL_CLI_URL=http://localhost:8080
   MENTION_TRIGGERS=claude:
   CLAUDE_MAX_TURNS=25
   ```

3. Run the bot in dev mode (hot reload via tsx):
   ```bash
   cd bot
   npm run dev
   ```

4. Send a message starting with the mention trigger (e.g. `claude: hello`) in a Signal group the bot is a member of.

### Troubleshooting

- **signal-cli connection issues**: Check `docker logs signal-cli` for `Connection closed unexpectedly` errors. Fix with `docker compose down signal-cli && docker compose up -d signal-cli` (full recreate, not just restart).
- **Bot not receiving messages**: The `extractMessageData` method only processes group messages with `dataMessage.message` and `groupInfo.groupId`. DMs and reactions are silently dropped.
- **MCP tools not working**: In dev mode, MCP servers run via `npx tsx` on the `.ts` source files. In production (Docker), they run via `node` on compiled `.js` in `dist/`. The `resolveMcpServerPath` helper in `claudeClient.ts` handles this automatically.
- **"Specified account does not exist"**: signal-cli failed to load the account on startup. Usually a transient network issue — recreate the container.

## Testing

```bash
cd bot
npm test              # Run all 166 tests (vitest watch mode)
npx vitest run        # Single run
npm run lint          # Biome lint
npm run check         # Biome lint + format check
```

## Production Deployment

```bash
docker compose up --build -d
```

This builds the bot container (compiles TS to JS), starts both signal-cli and the bot, and connects them via the `bot-network` Docker network.
