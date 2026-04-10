#!/usr/bin/env bash
set -euo pipefail

NUC_HOST="${NUC_HOST:-192.168.0.239}"
NUC_USER="${NUC_USER:-zknowles}"
NUC_PATH="${NUC_PATH:-signal-bot}"
NUC="${NUC_USER}@${NUC_HOST}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

# Write commit hash for startup notification
git rev-parse --short HEAD > "$REPO_DIR/VERSION"
cleanup_version() { rm -f "$REPO_DIR/VERSION"; }
trap cleanup_version EXIT

# ── Phase 1: Pre-flight ─────────────────────────────────────────────

echo "==> Pre-flight checks"

# Check SSH connectivity
if ! ssh -o ConnectTimeout=5 "$NUC" "true" 2>/dev/null; then
  echo "DEPLOY FAILED: Cannot reach ${NUC_HOST} via SSH"
  exit 1
fi

# Check signal-cli is running (bot depends on it)
SIGNAL_CLI_STATUS=$(ssh "$NUC" "systemctl is-active signal-cli 2>/dev/null" || true)
if [ "$SIGNAL_CLI_STATUS" != "active" ]; then
  echo "DEPLOY FAILED: signal-cli.service is not running (status: ${SIGNAL_CLI_STATUS})"
  echo "  Fix with: ssh ${NUC} \"sudo systemctl start signal-cli\""
  exit 1
fi

echo "    signal-cli: active"
echo "    SSH: ok"

# ── Phase 2: Sync & Install ─────────────────────────────────────────

echo ""
echo "==> Deploying to ${NUC}:~/${NUC_PATH}"

# Sync source files
rsync -avz --delete \
  --exclude='bot/data/' \
  --exclude='bot/.env' \
  --exclude='bot/node_modules/' \
  --exclude='bot/dist/' \
  --exclude='bot/models/' \
  --exclude='dashboard/node_modules/' \
  --exclude='dashboard/dist/' \
  --exclude='.git/' \
  --exclude='.worktrees/' \
  --exclude='.claude/worktrees/' \
  --exclude='.claude/memory/' \
  --exclude='.claude/plans/' \
  --exclude='logs/' \
  --exclude='factory/sessions/' \
  --exclude='factory/runs/' \
  --exclude='data/' \
  --exclude='node_modules/' \
  "$REPO_DIR/" "${NUC}:~/${NUC_PATH}/"

# Ensure data directory exists (belt-and-suspenders: rsync --exclude should protect it,
# but mkdir -p is cheap insurance against the directory being deleted)
ssh "$NUC" "mkdir -p ~/${NUC_PATH}/bot/data"

echo "==> Files synced"

# Build dashboard client locally and sync built files
echo "==> Building dashboard client..."
(cd "$REPO_DIR/dashboard/client" && npm install --silent && npm run build --silent)
rsync -avz "$REPO_DIR/dashboard/client/dist/" "${NUC}:~/${NUC_PATH}/dashboard/client/dist/"
echo "==> Dashboard client built and synced"

# Install dependencies for both bot and dashboard
echo "==> Installing dependencies..."
ssh "$NUC" "cd ~/${NUC_PATH}/bot && npm install"
ssh "$NUC" "cd ~/${NUC_PATH}/dashboard && npm install"

# Install systemd service files
echo "==> Installing systemd service files..."
ssh "$NUC" "sudo cp ~/${NUC_PATH}/scripts/systemd/*.service /etc/systemd/system/ && sudo systemctl daemon-reload"

# ── Phase 3: Backup Database ───────────────────────────────────────

echo ""
echo "==> Backing up NUC database..."
BACKUP_NAME="bot.db.$(date +%Y%m%d-%H%M%S).bak"
ssh "$NUC" "if [ -f ~/${NUC_PATH}/bot/data/bot.db ]; then cp ~/${NUC_PATH}/bot/data/bot.db ~/${NUC_PATH}/bot/data/${BACKUP_NAME} && echo '    backup: ${BACKUP_NAME}'; else echo '    no database to back up'; fi"
# Keep only the 5 most recent backups
ssh "$NUC" "ls -t ~/${NUC_PATH}/bot/data/bot.db.*.bak 2>/dev/null | tail -n +6 | xargs -r rm --"

# ── Phase 4: Restart Services ───────────────────────────────────────

echo ""
echo "==> Ensuring services are enabled on boot..."
ssh "$NUC" "sudo systemctl enable signal-cli signal-bot signal-bot-dashboard"

echo "==> Restarting services..."
ssh "$NUC" "sudo systemctl restart signal-bot && sudo systemctl restart signal-bot-dashboard"
RESTART_TIME=$(date -u +"%Y-%m-%d %H:%M:%S")

# ── Phase 5: Verify ─────────────────────────────────────────────────

echo "==> Waiting for startup..."
sleep 5

FAILED=0

# Check signal-bot status
BOT_STATUS=$(ssh "$NUC" "systemctl is-active signal-bot 2>/dev/null" || true)
if [ "$BOT_STATUS" != "active" ]; then
  echo "    signal-bot: $BOT_STATUS"
  FAILED=1
else
  echo "    signal-bot: active"
fi

# Check dashboard status
DASH_STATUS=$(ssh "$NUC" "systemctl is-active signal-bot-dashboard 2>/dev/null" || true)
if [ "$DASH_STATUS" != "active" ]; then
  echo "    signal-bot-dashboard: $DASH_STATUS"
  FAILED=1
else
  echo "    signal-bot-dashboard: active"
fi

# Check recent logs for error patterns (exclude known transient startup messages)
BOT_LOGS=$(ssh "$NUC" "journalctl -u signal-bot --since='${RESTART_TIME}' --no-pager -o cat 2>/dev/null" || true)
FILTERED_ERRORS=$(echo "$BOT_LOGS" | grep -E 'Error|FATAL|Cannot find module|ExitCode|EADDRINUSE' | grep -v 'Receive command cannot be used' || true)
if [ -n "$FILTERED_ERRORS" ]; then
  echo ""
  echo "    Errors detected in signal-bot logs:"
  echo "$FILTERED_ERRORS" | head -10 | sed 's/^/      /'
  FAILED=1
fi

echo ""
if [ "$FAILED" -eq 0 ]; then
  echo "DEPLOY OK"
else
  echo "DEPLOY FAILED — run scripts/nuc-health.sh for details"
  exit 1
fi
