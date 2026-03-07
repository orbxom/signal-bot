---
name: run-bot-test
description: Use when the user wants to start the bot in test mode, run dev:test, start the bot for the test channel, or says "start the bot" without mentioning mock testing.
---

# Run Bot (Test Channel Only)

Starts the bot connected to real signal-cli, restricted to the Bot Test group.

```bash
cd /home/zknowles/personal/signal-bot/bot
SIGNAL_CLI_URL=http://localhost:8080 npm run dev:test
```

Run this as a background task. Wait for `Starting message polling...` in the output before considering it ready.
