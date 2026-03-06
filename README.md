# Signal Family Bot

Claude-powered Signal bot for family group chat. Uses Claude CLI with a Max subscription — no API keys needed for the LLM.

## Features

- Responds to mentions (@bot or bot:) in group chats
- Maintains conversation context with sliding window history
- Powered by Claude via Claude CLI (`claude -p`)
- Message deduplication and self-message filtering
- Docker-based deployment with signal-cli
- SQLite storage for message history

## Prerequisites

- [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated (`claude login`)
- Active Claude Max subscription
- Node.js 20+
- Docker and Docker Compose (for deployment)

## Quick Start

1. Install and authenticate Claude CLI:
   ```bash
   npm install -g @anthropic-ai/claude-code
   claude login
   ```

2. Copy `.env.example` to `.env` and set your phone number:
   ```bash
   cp bot/.env.example .env
   # Edit .env — only BOT_PHONE_NUMBER is required
   ```

3. Build and start containers:
   ```bash
   docker compose up --build
   ```

4. Register Signal number (first time only):
   ```bash
   docker exec -it signal-cli signal-cli -a +61YOURPHONE register
   docker exec -it signal-cli signal-cli -a +61YOURPHONE verify CODE
   ```

5. Add bot to your Signal group and test with `@bot hello`

## Development

```bash
cd bot
npm install
npm test           # Run tests (112 tests)
npm run dev        # Development with hot reload
npm run build      # Build TypeScript
npm start          # Run built application
```

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BOT_PHONE_NUMBER` | Yes | - | Bot's Signal phone number |
| `MENTION_TRIGGERS` | No | `@bot` | Comma-separated trigger patterns |
| `CONTEXT_WINDOW_SIZE` | No | `20` | Messages to keep in context |
| `SIGNAL_CLI_URL` | No | `http://localhost:8080` | signal-cli daemon URL |
| `DB_PATH` | No | `./data/bot.db` | SQLite database path |
| `SYSTEM_PROMPT` | No | Family assistant prompt | Custom system prompt for Claude |
| `CLAUDE_MAX_TURNS` | No | `1` | Max agentic turns for Claude CLI |

## Documentation

- [Setup Guide](docs/setup.md)
- [Architecture Design](docs/plans/2025-12-20-signal-family-bot-design.md)

## License

MIT
