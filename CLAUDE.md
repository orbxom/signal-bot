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
- **MCP tools not working**: MCP servers run via `npx tsx` on the `.ts` source files. The `resolveMcpServerPath` helper in `claudeClient.ts` handles path resolution.

## Testing

```bash
cd bot
npm test              # Run all tests (vitest watch mode)
npx vitest run        # Single run
npm run lint          # Biome lint
npm run check         # Biome lint + format check
```
