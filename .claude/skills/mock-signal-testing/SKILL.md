---
name: mock-signal-testing
description: Use when testing the signal bot with the mock signal server specifically. Trigger on "run the mock", "mock testing", "send a test message to the mock", or "test with the mock server". Do NOT use for simply starting the bot — use run-bot or run-bot-test instead.
---

# Mock Signal Testing

End-to-end testing of the signal bot using the mock signal-cli server. This skill exists because headless testing has several non-obvious pitfalls around process management, port conflicts, and message routing.

## Pre-flight Checks

Before starting anything, always do these three things:

### 1. Kill ALL existing bot processes

Old bot processes linger and silently steal messages from the queue, making it look like the bot isn't responding. This is the #1 cause of "the bot isn't working" during testing.

```bash
pkill -f "tsx.*src/index.ts" 2>/dev/null
pkill -f "tsx.*signalServer" 2>/dev/null
sleep 1
ps aux | grep -E "tsx.*(index|signalServer)" | grep -v grep
```

The last command should return nothing. If processes remain, kill them by PID.

### 2. Check port availability

The mock server uses port 9090 (to avoid conflicts with real signal-cli on 8080). Verify it's free:

```bash
ss -tlnp | grep 9090
```

If something is on 9090, either kill it or use a different port via `MOCK_SIGNAL_PORT`.

### 3. Understand the .env override

The file `bot/.env` sets `SIGNAL_CLI_URL=http://localhost:8080`. The dotenv library does NOT override existing env vars, so setting `SIGNAL_CLI_URL` in the shell before starting the bot works. But you must set it explicitly — the `dev:test` npm script defaults to 9090, but `npx tsx src/index.ts` does not.

## Starting the Mock Server

The mock server (`bot/src/mock/signalServer.ts`) uses readline on stdin for interactive input. When stdin closes, the server exits. This means you cannot simply run it in the background — you need to keep stdin open.

### For headless/background testing (recommended for Claude Code):

```bash
cd /home/zknowles/personal/signal-bot/bot
(tail -f /dev/null | npx tsx src/mock/signalServer.ts &)
sleep 2
# Verify it's alive:
curl -s http://localhost:9090/api/v1/rpc \
  -d '{"jsonrpc":"2.0","method":"listGroups","params":{},"id":1}'
```

### Sending messages headlessly

The mock server has a `queueMessage` RPC method for injecting messages without stdin:

```bash
curl -s http://localhost:9090/api/v1/rpc \
  -d '{"jsonrpc":"2.0","method":"queueMessage","params":{"message":"claude: hello"},"id":1}'
```

This returns `{"queued":true,"queueLength":1}`. The bot will pick it up on the next poll cycle (every 2 seconds).

**Do NOT call the `receive` method manually** — it drains the queue, preventing the bot from seeing messages.

## Starting the Bot

### If the real bot is also running (recommended):

Use `dev:mock` — it uses a separate database (`data/mock-bot.db`) so both instances can run simultaneously without SQLite conflicts:

```bash
cd /home/zknowles/personal/signal-bot/bot
npm run dev:mock
```

### If no other bot instance is running:

```bash
cd /home/zknowles/personal/signal-bot/bot
npm run dev:test                       # Shares the main DB, defaults to port 9090
```

Or manually:

```bash
cd /home/zknowles/personal/signal-bot/bot
SIGNAL_CLI_URL=http://localhost:9090 npx tsx src/index.ts --test-channel-only
```

Wait for `Starting message polling...` in the output before sending messages.

## Verifying Bot Output

### The bot log file is the source of truth

Background process stdout may be buffered or incomplete. Always check the log file:

```bash
ls -t /home/zknowles/personal/signal-bot/logs/bot-*.log | head -1 | xargs tail -50
```

The logger writes synchronously via `appendFileSync`, so the log file is always current.

### Expected output for a successful mention

```
─ POLL  #N received 1 message(s)
─ RECV  [groupId] +61400111222: claude: <message>
│ query: "<extracted query>"
│ context: N dossiers, with/without persona
│ llm: spawning claude -p (max turns: 25)
│ llm: system prompt Xk chars, conversation Xk chars
│ llm: N input / N output tokens
│ llm: result via result field
│ llm: response in X.Xs (N tokens)
│ delivery: sent via fallback
└ COMPLETE
```

### Expected output for a non-mention message

```
─ POLL  #N received 1 message(s)
─ RECV  [groupId] +61400111222: <message>
```

No LLM processing lines should follow — the message is stored but not processed.

## Test Sequence

A good smoke test covers these cases in order:

1. **Basic mention**: `claude: hello` — verify full LLM round-trip
2. **Non-mention**: `just a regular message` — verify it's stored but not processed
3. **Second mention**: `claude: what is 2+2?` — verify consistency, no duplicate responses
4. **MCP tool usage** (optional): `claude: what reminders do I have?` — verify MCP tools load

Wait for each mention to complete (look for `COMPLETE` in logs) before sending the next.

## Cleanup

```bash
pkill -f "tsx.*src/index.ts" 2>/dev/null
pkill -f "tsx.*signalServer" 2>/dev/null
pkill -f "tail -f /dev/null" 2>/dev/null
```

## Common Pitfalls

| Symptom | Cause | Fix |
|---------|-------|-----|
| Bot shows no output after "Starting message polling..." | Old bot processes consuming messages | Kill ALL tsx processes first |
| Mock server exits immediately in background | stdin closed | Use `tail -f /dev/null` pipe |
| Bot connects but sends to wrong server | `.env` SIGNAL_CLI_URL=8080 wins | Set `SIGNAL_CLI_URL=http://localhost:9090` explicitly |
| Message queued but bot doesn't see it | Manual `receive` call drained queue | Never call `receive` manually |
| Port 9090 already in use | Previous mock server still running | `pkill -f signalServer` first |
| Claude CLI takes 30+ seconds | Normal for complex queries with MCP tools | Wait; check logs for progress |
