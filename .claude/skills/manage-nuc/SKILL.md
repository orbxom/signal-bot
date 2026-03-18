---
name: manage-nuc
description: Use when the user mentions the NUC, deploying to production, checking bot health, restarting services on the server, viewing production logs, or anything about the remote Intel NUC server at 192.168.0.239. Triggers on "deploy", "deploy to nuc", "push to nuc", "check the nuc", "nuc health", "is the bot running", "restart the bot on the nuc", "production logs", "nuc logs", "nuc status", "restart signal-cli", "restart the production bot", "what's happening on the nuc", or any mention of the NUC server. Even if the user just says "deploy" in the context of this project, use this skill.
---

# Manage NUC Production Server

The signal bot runs in production on an Intel NUC (i5-7260U, 16GB RAM) at `192.168.0.239`, user `zknowles`. SSH key auth is configured — all commands run via `ssh zknowles@192.168.0.239`.

## Operations

### Deploy

Syncs current source code to the NUC, installs deps if needed, restarts services, and verifies health:

```bash
/home/zknowles/personal/signal-bot/scripts/deploy-nuc.sh
```

The script runs 4 phases:
1. **Pre-flight** — checks SSH connectivity and that `signal-cli.service` is running (exits early if not)
2. **Sync & Install** — rsyncs source (excludes data/.env/node_modules), runs `npm install` for bot + dashboard, installs systemd service files
3. **Restart** — enables all 3 services on boot (`systemctl enable`), restarts `signal-bot` and `signal-bot-dashboard`
4. **Verify** — waits 5s, checks both services are active, scans recent logs for error patterns

Prints **DEPLOY OK** or **DEPLOY FAILED** at the end. If failed, run `nuc-health.sh` for deeper investigation.

### Health Check

```bash
/home/zknowles/personal/signal-bot/scripts/nuc-health.sh      # 20 log lines
/home/zknowles/personal/signal-bot/scripts/nuc-health.sh 50   # more lines
```

Shows system resources, service status, signal-cli API responsiveness, and recent logs.

### View Live Logs

```bash
ssh zknowles@192.168.0.239 "journalctl -u signal-bot -f"
```

Run as a background task. For signal-cli logs: replace `signal-bot` with `signal-cli`.

### Restart Services

```bash
ssh zknowles@192.168.0.239 "sudo systemctl restart signal-bot"
ssh zknowles@192.168.0.239 "sudo systemctl restart signal-cli"
```

Restart signal-bot for code/config changes. Restart signal-cli only if it's unresponsive or needs a version update.

### Check Service Status

```bash
ssh zknowles@192.168.0.239 "systemctl status signal-bot signal-cli --no-pager"
```

### Dashboard

The dark factory dashboard runs on the NUC at http://192.168.0.239:3333. Managed by `signal-bot-dashboard.service`.

## NUC Environment

- **Repo path**: `~/signal-bot` (cloned from GitHub, updated via deploy script)
- **Bot .env**: `~/signal-bot/bot/.env` — has `EXCLUDE_GROUP_IDS` set to ignore the Bot Test channel
- **signal-cli**: Native binary v0.14.1 at `/usr/local/bin/signal-cli`, data at `/var/lib/signal-cli`
- **Claude CLI**: Installed globally via npm, authenticated
- **Services**: `signal-cli.service`, `signal-bot.service`, `signal-bot-dashboard.service`
- **Service templates**: `scripts/systemd/` in the repo

## Dev vs Prod Channel Separation

The NUC bot and local dev bot share the same Signal phone number but respond to different groups:
- **NUC (production)**: Responds to all groups EXCEPT the Bot Test channel (`EXCLUDE_GROUP_IDS`)
- **PC (development)**: Only responds to the Bot Test channel (`--test-channel-only`)

Messages are always stored in both databases regardless of filtering. The separation prevents duplicate responses.
