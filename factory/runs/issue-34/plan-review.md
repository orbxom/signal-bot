# Devil's Advocate Review — Issue #34

## Critical Issues

### 1. Path Encoding Bug (VALID — FIXED)
The plan had `\`-${projectRoot().replace(/\//g, '-')}\`` which produces `--home-...` (double dash). The correct encoding is just `projectRoot().replace(/\//g, '-')` — the leading `/` naturally becomes the leading `-`.

### 2. Worktree Path Concern (DISMISSED)
The reviewer worried that dark factory uses worktrees, so JSONL files would be in the wrong directory. However, the **main Claude session** starts from the project root. It spawns subagents in worktrees, but those subagent JSONL files are nested under the main session's directory (`<session-uuid>/subagents/`). The main conversation JSONL stays in the main project's Claude directory.

### 3. JSONL File Correlation (VALID — IMPROVED)
mtime-based heuristic is fragile with concurrent sessions. Fix: also check the first few lines of each candidate JSONL file for a user message containing `dark factory issue <N>` to confirm the right file.

### 4. Security — Signal Users Triggering Sessions (VALID — GATED)
Added `DARK_FACTORY_ENABLED` env var gate. Tools return error when not enabled. Not registered in tool allowlist by default.

### 5. KDL Escaping (PARTIALLY VALID — ACCEPTABLE)
Issue number is validated as a number and project root is a known filesystem path. No KDL-special characters possible in these values. Added a test for layout generation.

### 6. Test Mirrors Implementation (VALID — FIXED)
Task 4 test now uses a hardcoded expected path rather than computing it with the same logic.

## Dismissed Concerns

- **"Is MCP the right abstraction?"** — Yes, it follows the existing pattern and the user specifically asked for MCP tools.
- **"Interactive mode but Signal users can't watch"** — The terminal is for the local developer. Signal users get progress via `read_dark_factory`.
- **Temp file cleanup** — OS handles `/tmp` cleanup. Not worth adding complexity.
- **`require.main === module`** — Consistent with all existing servers.
