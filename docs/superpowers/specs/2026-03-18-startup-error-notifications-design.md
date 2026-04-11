# Startup & Error Notifications

## Overview

When the bot starts up successfully on the NUC, it sends a notification to the Bot Test Signal channel with the current git commit hash. When it crashes due to an unhandled error, it sends the error details to the same channel before exiting. This provides passive confirmation that deploys succeeded and alerts on runtime crashes without requiring log monitoring.

## Notification Types

### Startup Notification

Sent after `waitForReady()` succeeds and before the polling loop begins.

**Format:**
```
Bot online (abc1234) — 2026-03-18 14:32 AEDT
```

- Commit hash sourced from a `VERSION` file written by the deploy script (avoids needing `.git/` on the NUC)
- Falls back to `"unknown"` if `VERSION` file is missing
- Timestamp formatted in the bot's configured timezone (`BOT_TIMEZONE`, default `Australia/Sydney`)

### Error Notification

Sent on unhandled rejections and fatal startup errors. The current `unhandledRejection` handler only logs — it does not exit. This feature adds `process.exit(1)` after sending the error notification, since an unhandled rejection indicates an unexpected state that warrants a restart (systemd will restart the service automatically).

**Format:**
```
Bot error — shutting down

TypeError: Cannot read properties of undefined (reading 'foo')
    at MessageHandler.handle (/home/zknowles/signal-bot/bot/src/messageHandler.ts:42:15)
    ...
```

- Includes full error message and stack trace
- Full formatted message (header + error + stack) truncated to 2000 characters total to stay within Signal message limits
- Best-effort: if signal-cli is not reachable (e.g., early startup failure before signal-cli connects), the error is logged and the bot exits as it does today

## Notification Channel

All notifications are sent to the Bot Test group (`config.testGroupId`) via `signalClient.sendMessage()` directly. This bypasses the message handler's channel filtering, so notifications work even though the NUC production config excludes the test group via `EXCLUDE_GROUP_IDS`. This is intentional — the bot sends to the group but doesn't process responses to these notifications.

## Activation

Controlled by a `STARTUP_NOTIFY` environment variable (read as `config.startupNotify` boolean). When false or unset, no notifications are sent.

- **NUC production:** `STARTUP_NOTIFY=true` in `bot/.env`
- **Dev machine:** Not set — no startup spam during development restarts

## Commit Hash via VERSION File

The deploy script (`scripts/deploy-nuc.sh`) writes `git rev-parse --short HEAD` to a `VERSION` file in the repo root before rsyncing to the NUC. This avoids requiring `.git/` on the NUC (already excluded from rsync).

At startup, the bot reads `VERSION` from the repo root using `path.resolve(__dirname, '../../VERSION')` (two levels up from `bot/src/`). If the file doesn't exist (e.g., running locally in dev), the commit hash displays as `"unknown"`.

## Changes

### `bot/src/config.ts`
- Add `startupNotify: boolean` to the `ConfigType` interface and `Config.load()`, read from `STARTUP_NOTIFY` env var (default `false`)

### `bot/src/index.ts`
- Add `sendStartupNotification(signalClient, config)` — reads `VERSION` file, formats timestamp, sends message to `config.testGroupId`. Called after `waitForReady()`, before the polling loop.
- Add `sendErrorNotification(signalClient, config, error)` — formats error with stack trace (truncated to 2000 chars), sends to `config.testGroupId`. Best-effort: catches and logs any send failure silently.
- Wire `sendErrorNotification` into the `unhandledRejection` handler and `main().catch()` block. Both are best-effort — if signal-cli isn't available, just log and exit as today.

### `scripts/deploy-nuc.sh`
- Before the rsync step, run `git rev-parse --short HEAD > VERSION` to write the commit hash
- The `VERSION` file is synced to the NUC with everything else
- Use a `trap` to clean up the local `VERSION` file on script exit (ensures cleanup even if deploy fails partway)

### NUC `bot/.env`
- Add `STARTUP_NOTIFY=true`

### `.gitignore`
- Add `VERSION` (generated file, should not be committed)

### `CLAUDE.md`
- Add `STARTUP_NOTIFY=true` to the "NUC .env Differences" section

## Error Handling Edge Cases

- **Signal-cli not ready during error notification:** Send attempt fails silently, error is logged, process exits. The deploy script's `systemctl status` output covers this case.
- **Error during startup notification itself:** Caught and logged, does not prevent the bot from starting the polling loop.
- **Multiple rapid unhandled rejections:** The first one triggers a notification and `process.exit(1)`. Systemd restarts the service automatically.

## Testing

- Unit test `sendStartupNotification` and `sendErrorNotification` with a mock signal client
- Verify `startupNotify: false` (default) suppresses notifications
- Verify truncation of long error messages to 2000 characters
- Verify graceful handling when `VERSION` file is missing
- Integration: deploy to NUC and confirm notification arrives in Bot Test group
