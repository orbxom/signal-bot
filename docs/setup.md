# Setup Guide

## Prerequisites

- Docker and Docker Compose
- [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- Active Claude Max subscription
- Phone number for Signal bot registration
- Signal account to add bot to group

## Local Development

### 1. Install Claude CLI

```bash
npm install -g @anthropic-ai/claude-code
claude login
```

Verify it works:
```bash
echo "test" | claude -p "say hello" --output-format json --max-turns 1
```

### 2. Install Dependencies

```bash
cd bot
npm install
```

### 3. Configure Environment

```bash
cp bot/.env.example .env
```

Edit `.env`:
- `BOT_PHONE_NUMBER` - Phone number registered with Signal (required)
- `SYSTEM_PROMPT` - Custom system prompt (optional)

### 4. Run Tests

```bash
cd bot
npm test
```

### 5. Run in Development

```bash
cd bot
npm run dev
```

## Docker Setup

### 1. Build and Start

```bash
docker compose up --build
```

The bot container mounts `~/.claude` read-only for Claude CLI authentication.

### 2. Register Signal Number

First time only - register the bot's phone number:

```bash
# Start just signal-cli first
docker compose up -d signal-cli

# Request verification code
docker exec -it signal-cli signal-cli -a +61YOURPHONE register

# Verify with SMS code
docker exec -it signal-cli signal-cli -a +61YOURPHONE verify XXXXXX

# Start the bot
docker compose up -d bot
```

### 3. Add Bot to Group

From your main Signal account:
1. Create or open your family group
2. Add the bot's phone number
3. Test with: `@bot hello`

## Monitoring

```bash
# View bot logs
docker compose logs -f bot

# View signal-cli logs
docker compose logs -f signal-cli

# Check container status
docker compose ps
```

## Troubleshooting

**Bot doesn't respond:**
- Check logs: `docker compose logs bot`
- Verify signal-cli is running: `docker compose ps`
- Test Signal connection: `docker exec -it signal-cli signal-cli listGroups`

**Claude CLI errors:**
- Verify Claude CLI is authenticated: `claude --version`
- Check your Max subscription is active
- Look for "Claude CLI not found" or "timed out" in bot logs

**Database issues:**
- Database at `./data/bot/bot.db`
- Inspect: `sqlite3 ./data/bot/bot.db "SELECT count(*) FROM messages;"`
