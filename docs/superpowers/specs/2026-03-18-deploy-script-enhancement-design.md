# Deploy Script Enhancement Design

**Date:** 2026-03-18
**Status:** Approved

## Problem

The current `deploy-nuc.sh` script syncs code and restarts the bot, but:
- Doesn't verify signal-cli is running before deploying (bot depends on it)
- Doesn't restart the dashboard service
- Doesn't check logs for startup errors
- Doesn't give a clear pass/fail verdict

The user wants a "don't think about it" deploy: run the script, get told if it worked or not.

## Design

Enhance `scripts/deploy-nuc.sh` with a 4-phase flow. No new files.

### Phase 1 — Pre-flight

1. Check SSH connectivity to NUC (fail fast if unreachable)
2. Check `signal-cli.service` is `active` — if not, print warning with status and exit non-zero

### Phase 2 — Sync & Install (unchanged)

1. Rsync source files with existing exclude list
2. Check `package.json` hash — run `npm install` only if changed

### Phase 3 — Restart Services

1. `sudo systemctl restart signal-bot`
2. `sudo systemctl restart signal-bot-dashboard`

### Phase 4 — Verify

1. Wait 5 seconds for startup
2. Check both services are `active (running)` via `systemctl is-active`
3. Grab last 20 lines of `signal-bot` journal logs (since restart timestamp)
4. Scan for error patterns: `Error`, `FATAL`, `Cannot find module`, `ExitCode`, `EADDRINUSE`
5. Print verdict:
   - **DEPLOY OK** — both services active, no error patterns found
   - **DEPLOY FAILED** — service not active or errors detected; dump relevant logs

### Error Patterns

The log scan uses case-sensitive grep for these patterns:
- `Error` — generic runtime errors
- `FATAL` — fatal startup failures
- `Cannot find module` — missing dependency / bad import
- `ExitCode` — systemd reporting non-zero exit
- `EADDRINUSE` — port conflict

This is intentionally simple. False positives (e.g., the word "Error" in a benign context) are acceptable — better to over-report than miss a real failure. The user can always run `nuc-health.sh` for deeper investigation.

## Documentation Updates

### `manage-nuc` skill (`.claude/skills/manage-nuc/SKILL.md`)

Update the Deploy section to describe the new 4-phase behavior: pre-flight checks, dashboard restart, and OK/FAILED verdict. Remove the note about manually looking for `EXCLUDING groups` output.

### `CLAUDE.md`

Update the Deploying section to mention pre-flight checks and post-deploy verification.

## Out of Scope

- `nuc-health.sh` — unchanged, still useful for ad-hoc investigation
- Systemd service files — already correct (`Restart=always`, `Requires=signal-cli.service`)
- Waiting for a specific "bot ready" log line (option B from brainstorming) — simple active check is sufficient
