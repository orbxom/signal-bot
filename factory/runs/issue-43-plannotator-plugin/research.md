# Research — issue-43-plannotator-plugin

## Current State

### Plannotator Already Installed
- **Version:** 0.8.2 (installed 2026-02-19)
- **User-scope plugin:** enabled in `~/.claude/settings.json` (`"plannotator@plannotator": true`)
- **Binary:** `/home/zknowles/.local/bin/plannotator` (ELF binary, works as hook — fails standalone as it expects stdin JSON)
- **Cache:** `/home/zknowles/.claude/plugins/cache/plannotator/plannotator/0.8.2/`

### Hook Mechanism
The plugin ships one hook in `hooks/hooks.json`:
- **Event:** `PermissionRequest`
- **Matcher:** `ExitPlanMode`
- **Action:** Runs `plannotator` binary (reads hook JSON from stdin, starts web server, opens browser)
- **Timeout:** 345600s (4 days)

**Flow:** EnterPlanMode → Claude presents plan → ExitPlanMode → PermissionRequest hook fires → plannotator opens browser UI → human reviews/annotates → result returned to Claude

### Dark Factory Already References It
- `SKILL.md` Stage 1, Step 5 already says "Switch to plan mode using EnterPlanMode" and "This launches the Plannotator UI"
- Commit `fff5835` (2026-03-07) added this reference

### Available Commands
- `/plannotator-annotate` — Open interactive annotation UI for a markdown file
- `/plannotator-review` — Open interactive code review for current changes

### Environment Variables
| Variable | Description |
|----------|-------------|
| `PLANNOTATOR_REMOTE` | Set to `1` for remote/SSH mode (fixed port 19432, skips browser) |
| `PLANNOTATOR_PORT` | Override default port (random locally) |
| `PLANNOTATOR_BROWSER` | Custom browser executable |

## Gap Analysis

### What's Done
- [x] Plugin installed at user scope
- [x] Binary in PATH
- [x] Hook configured for ExitPlanMode
- [x] Dark factory skill references EnterPlanMode + plannotator

### What's Missing
1. **No project-level documentation** — CLAUDE.md doesn't mention plannotator as a dependency
2. **No verification** that the hook actually fires during dark factory runs
3. **No explicit use of /plannotator-annotate** for reviewing plan.md files
4. **No /plannotator-review** integration for Stage 7 (code review)
5. **Subagent PATH inheritance** — unclear if subagents/worktrees can find the binary
6. **No settings.local.json configuration** for project-level env vars (PLANNOTATOR_PORT etc.)

## Related Work
- **Issue #40** (dark factory input) — zellij CLI for session input, may interact with plannotator UI
- **Issue #41** (prompt reminders) — spawns Claude sessions that could benefit from plannotator
- **Issue #42** (tool notifications) — plan stage in-progress
- **Issue #36** (health check) — test completion stage

No direct conflicts identified.

## Risk Areas
1. **Scope mismatch:** Plugin at user scope should propagate to all sessions, but untested in dark factory context
2. **Browser availability:** Headless/remote sessions need PLANNOTATOR_REMOTE=1
3. **Port conflicts:** Multiple dark factory runs could collide on ports
4. **PATH in subagents:** ~/.local/bin must be in PATH for hook to find plannotator binary
5. **Known bug:** PostToolUse:EnterPlanMode doesn't fire for user-initiated plan mode (GitHub issue #15660) — doesn't affect plannotator since it hooks ExitPlanMode instead
