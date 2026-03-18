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

echo "==> Deploying to ${NUC}:~/${NUC_PATH}"

# Get remote package.json checksum before sync
REMOTE_PKG_HASH=$(ssh "$NUC" "md5sum ~/${NUC_PATH}/bot/package.json 2>/dev/null | cut -d' ' -f1" || echo "none")

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

echo "==> Files synced"

# Check if package.json changed
LOCAL_PKG_HASH=$(md5sum "$REPO_DIR/bot/package.json" | cut -d' ' -f1)
if [ "$REMOTE_PKG_HASH" != "$LOCAL_PKG_HASH" ]; then
  echo "==> package.json changed, running npm install..."
  ssh "$NUC" "cd ~/${NUC_PATH}/bot && npm install"
else
  echo "==> package.json unchanged, skipping npm install"
fi

# Restart signal-bot service
echo "==> Restarting signal-bot service..."
ssh "$NUC" "sudo systemctl restart signal-bot"

# Wait for startup
sleep 3

# Show status
echo ""
echo "==> Service status:"
ssh "$NUC" "systemctl status signal-bot --no-pager -l" || true

echo ""
echo "==> Deploy complete"
