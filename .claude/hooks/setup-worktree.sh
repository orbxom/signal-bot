#!/bin/bash
# Setup a new worktree with symlinks and config from the main repo.
# Called by:
#   - WorktreeCreate hook (cwd = worktree path)
#   - PostToolUse:Bash hook (parses git worktree add from tool_input)
set -euo pipefail

INPUT=$(cat)
EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // empty')
MAIN_REPO="${CLAUDE_PROJECT_DIR:-}"

# Determine worktree path based on event type
if [ "$EVENT" = "WorktreeCreate" ]; then
  WORKTREE=$(echo "$INPUT" | jq -r '.cwd // empty')
elif [ "$EVENT" = "PostToolUse" ]; then
  CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
  # Only act on git worktree add commands
  echo "$CMD" | grep -q 'git worktree add' || exit 0
  # Extract the worktree path (second arg after 'git worktree add')
  WORKTREE=$(echo "$CMD" | grep -oP 'git worktree add\s+\K\S+')
  # Resolve relative to cwd
  CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
  if [ -n "$CWD" ] && [[ ! "$WORKTREE" = /* ]]; then
    WORKTREE="$CWD/$WORKTREE"
  fi
else
  exit 0
fi

# Validate
[ -z "$WORKTREE" ] && exit 0
[ -z "$MAIN_REPO" ] && exit 0
[ "$WORKTREE" = "$MAIN_REPO" ] && exit 0
[ ! -d "$WORKTREE" ] && exit 0

# 1. Symlink factory/ to main repo's factory/
if [ -d "$MAIN_REPO/factory" ] && [ -d "$WORKTREE/factory" ] && [ ! -L "$WORKTREE/factory" ]; then
  rm -rf "$WORKTREE/factory"
  ln -s "$MAIN_REPO/factory" "$WORKTREE/factory"
fi

# 2. Symlink .claude/settings.local.json to main repo's copy
if [ -f "$MAIN_REPO/.claude/settings.local.json" ]; then
  mkdir -p "$WORKTREE/.claude"
  rm -f "$WORKTREE/.claude/settings.local.json"
  ln -s "$MAIN_REPO/.claude/settings.local.json" "$WORKTREE/.claude/settings.local.json"
fi

# 3. Symlink bot/.env to main repo's copy
if [ -f "$MAIN_REPO/bot/.env" ]; then
  rm -f "$WORKTREE/bot/.env"
  ln -s "$MAIN_REPO/bot/.env" "$WORKTREE/bot/.env"
fi

# 4. Symlink bot/data/ to main repo's copy
if [ -d "$MAIN_REPO/bot/data" ]; then
  rm -rf "$WORKTREE/bot/data"
  ln -s "$MAIN_REPO/bot/data" "$WORKTREE/bot/data"
fi

# 5. Symlink bot/node_modules/ to main repo's copy
if [ -d "$MAIN_REPO/bot/node_modules" ]; then
  rm -rf "$WORKTREE/bot/node_modules"
  ln -s "$MAIN_REPO/bot/node_modules" "$WORKTREE/bot/node_modules"
fi

# 6. Symlink dashboard/node_modules/ to main repo's copy
if [ -d "$MAIN_REPO/dashboard/node_modules" ]; then
  rm -rf "$WORKTREE/dashboard/node_modules"
  ln -s "$MAIN_REPO/dashboard/node_modules" "$WORKTREE/dashboard/node_modules"
fi

# 7. Symlink dashboard/client/node_modules/ to main repo's copy
if [ -d "$MAIN_REPO/dashboard/client/node_modules" ]; then
  rm -rf "$WORKTREE/dashboard/client/node_modules"
  ln -s "$MAIN_REPO/dashboard/client/node_modules" "$WORKTREE/dashboard/client/node_modules"
fi

# 8. Symlink logs/ to main repo's copy
if [ -d "$MAIN_REPO/logs" ]; then
  rm -rf "$WORKTREE/logs"
  ln -s "$MAIN_REPO/logs" "$WORKTREE/logs"
fi
