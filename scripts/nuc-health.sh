#!/usr/bin/env bash
set -euo pipefail

NUC_HOST="${NUC_HOST:-192.168.0.239}"
NUC_USER="${NUC_USER:-zknowles}"
NUC="${NUC_USER}@${NUC_HOST}"
LOG_LINES="${1:-20}"

echo "=== NUC Health Check (${NUC_HOST}) ==="
echo ""

echo "--- System ---"
ssh "$NUC" "uptime && echo '' && free -h | head -3 && echo '' && df -h / | tail -1"
echo ""

echo "--- signal-cli.service ---"
ssh "$NUC" "systemctl is-active signal-cli 2>/dev/null || echo 'NOT RUNNING'"
echo ""

echo "--- signal-bot.service ---"
ssh "$NUC" "systemctl is-active signal-bot 2>/dev/null || echo 'NOT RUNNING'"
echo ""

echo "--- signal-cli API check ---"
ssh "$NUC" 'curl -sf -X POST -H "Content-Type: application/json" -d "{\"jsonrpc\":\"2.0\",\"method\":\"listAccounts\",\"id\":1}" http://localhost:8080 2>/dev/null | head -c 200 || echo "UNREACHABLE"'
echo ""
echo ""

echo "--- signal-bot logs (last ${LOG_LINES} lines) ---"
ssh "$NUC" "journalctl -u signal-bot --no-pager -n ${LOG_LINES} --output=short-iso" 2>/dev/null || echo "(no logs found)"
echo ""

echo "--- signal-cli logs (last 10 lines) ---"
ssh "$NUC" "journalctl -u signal-cli --no-pager -n 10 --output=short-iso" 2>/dev/null || echo "(no logs found)"
echo ""

echo "=== Done ==="
