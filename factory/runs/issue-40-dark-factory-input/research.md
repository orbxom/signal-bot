# Research — issue-40-dark-factory-input

## 1. Zellij CLI: Sending Input to Named Sessions

### `write-chars` — Send text to the focused pane

```bash
# Basic: write characters to the focused pane of a session
zellij -s <SESSION_NAME> action write-chars "some text"

# Send text followed by Enter (carriage return, byte 13)
zellij -s <SESSION_NAME> action write-chars "y" && zellij -s <SESSION_NAME> action write 13

# Alternative: embed newline using bash $'' syntax
zellij -s <SESSION_NAME> action write-chars $'y\n'
```

### `write` — Send raw bytes

```bash
# Send Enter key (carriage return = byte 13)
zellij -s <SESSION_NAME> action write 13

# Send Ctrl+C (byte 3)
zellij -s <SESSION_NAME> action write 3

# Send Escape (byte 27)
zellij -s <SESSION_NAME> action write 27
```

### Session targeting with `-s`

The `-s` / `--session` flag goes on the `zellij` command, BEFORE `action`:
```bash
zellij -s my-session action write-chars "hello"
#      ^^^^^^^^^^^^^^ session target
#                      ^^^^^^^^^^^^^^^^^^^^^ action
```

### Known bug: `--session` silently fails on detached sessions (zellij 0.43.1)

- **Issue:** [zellij-org/zellij#4535](https://github.com/zellij-org/zellij/issues/4535)
- **Version affected:** 0.43.1 (our installed version)
- **Root cause:** Actions only work if the session is **attached** somewhere. Detached sessions silently ignore actions.
- **Fix:** Merged in [PR #4626](https://github.com/zellij-org/zellij/pull/4626), will be in next release.
- **Impact on us:** Our dark factory sessions run inside kitty terminal windows, so they ARE attached. This is confirmed working — tested `dump-screen` against `dark-factory-40-1772885104868` successfully.

### Practical implication

Since dark factory sessions launch in `kitty` windows (always attached), `write-chars` and `dump-screen` will work with session targeting. If the kitty window is closed, the session becomes detached and commands will silently fail (on 0.43.1). We should detect this case.

---

## 2. Zellij Session Management

### List sessions

```bash
# Full output with formatting
zellij list-sessions

# Short (names only)
zellij list-sessions --short

# No ANSI colors (parseable)
zellij list-sessions --no-formatting
```

### Output format (no-formatting)

```
dark-factory-40-1772885104868 [Created 0s ago] (current)
dark-factory-42-1772885497304 [Created 0s ago]
dark-factory-36-1772884735713 [Created 0s ago] (EXITED - attach to resurrect)
```

Key states:
- `(current)` — attached and we're in it
- No suffix — attached somewhere else (e.g., in a kitty window)
- `(EXITED - attach to resurrect)` — process exited, session can be resurrected

### Check if a session exists

```bash
# Check by name (exact match)
zellij list-sessions --short | grep -q "^dark-factory-40-1772885104868$"

# Check if running (not exited)
zellij list-sessions --no-formatting | grep "dark-factory-40" | grep -qv "EXITED"
```

### Kill a session

```bash
zellij kill-session <SESSION_NAME>
zellij kill-all-sessions
```

### Session naming in dark factory

Sessions are named: `dark-factory-{issueNumber}-{timestamp}`
Example: `dark-factory-40-1772885104868`

Metadata is stored at: `factory/sessions/{sessionName}.json`

---

## 3. Zellij Screen Capture (dump-screen)

### Basic usage

```bash
# Dump visible viewport only
zellij -s <SESSION_NAME> action dump-screen /tmp/output.txt

# Dump with full scrollback history
zellij -s <SESSION_NAME> action dump-screen --full /tmp/output.txt
```

### Behavior

- Dumps the **focused pane** content to a file
- With `--full` flag, includes the entire scrollback buffer
- Output is plain text with Unicode characters preserved (Claude Code uses Unicode box-drawing chars, bullet points, etc.)
- Returns exit code 0 on success, 1 on failure (e.g., session not found or not attached)

### Verified output

Tested against `dark-factory-40-1772885104868`:
- `dump-screen` (without `--full`): captures visible viewport
- `dump-screen --full`: captured 314 lines including full scrollback

### Pane targeting

Currently `dump-screen` only targets the **focused** pane. There is no pane-id targeting flag in zellij 0.43.1. This is fine for dark factory sessions since each session has a single pane (as defined in the KDL layout).

### Reading last N lines

For the `send_dark_factory_input` tool, we need the last N lines to understand context:
```bash
zellij -s <SESSION> action dump-screen /tmp/dump.txt && tail -N /tmp/dump.txt
```

---

## 4. Claude Code Interactive Prompts

### Permission modes (status bar)

Claude Code has three permission modes, cycled with shift+tab:
1. **Normal mode** — asks permission for everything (no special indicator)
2. **Auto-accept edits** — `⏵⏵ accept edits on (shift+tab to cycle)` — auto-accepts file edits, still prompts for bash commands
3. **Plan mode** — `⏸ plan mode on` — read-only, no modifications

The dark factory currently launches Claude Code interactively (not `claude -p`), and the observed sessions are running in **auto-accept edits** mode.

### What prompts appear in auto-accept mode

In auto-accept mode, Claude Code will prompt for:
- **Bash command execution** — each bash command needs approval
- **Potentially dangerous operations** — destructive commands

File edits are auto-approved.

### What prompts look like in the terminal

From the dump-screen output, Claude Code's terminal UI looks like:
```
● Bash(command here)
  ⎿  [output shown here]

● Edit(file path)
  ⎿  [diff shown here]
```

The input prompt is a simple `❯ ` character at the bottom of the screen.

### Alternative: `--dangerously-skip-permissions`

To avoid prompts entirely:
```bash
claude --dangerously-skip-permissions "/dark-factory issue 40"
```

This bypasses ALL permission prompts. However:
- Anthropic recommends using this only in containers
- 32% of developers encountered unintended file modifications
- 9% reported data loss

### Alternative: `--permission-prompt-tool`

Claude Code has an undocumented `--permission-prompt-tool` flag that allows programmatic permission handling via an MCP tool. This could be an alternative to keystroke injection but:
- Documentation is sparse/missing
- No working examples in official docs
- Would require significant experimentation

### Practical approach for send_dark_factory_input

Since sessions run in **auto-accept edits** mode, the main prompts needing input will be:
1. **Bash command approvals** — the y/Enter to approve bash execution
2. **User input at the `❯` prompt** — typing responses when Claude asks questions
3. **Ctrl+C** — to interrupt if needed

The simplest approach is keystroke injection via `write-chars` + `write 13`.

---

## 5. Existing Dark Factory Implementation

### Source: `/home/zknowles/personal/signal-bot/bot/src/mcp/servers/darkFactory.ts`

**Current tools:**
1. `start_dark_factory` — launches kitty + zellij + claude session
2. `read_dark_factory` — reads JSONL conversation files from `~/.claude/projects/` dir

**Launch mechanism:**
```
kitty --title <sessionName> zellij -s <sessionName> --new-session-with-layout <layout.kdl>
```

KDL layout runs:
```bash
cd '/home/zknowles/personal/signal-bot' && claude "/dark-factory issue N"
```

**Key detail:** `CLAUDECODE: ''` is set in the spawn env (clears the `CLAUDECODE` variable so the inner Claude doesn't think it's nested).

**Session metadata:** Stored at `factory/sessions/{sessionName}.json` with:
- `sessionName`, `issueNumber`, `launchedAt`, `layoutPath`

**read_dark_factory approach:** Currently reads from Claude's JSONL conversation files, NOT from dump-screen. This gives structured data about assistant messages and tool usage, but cannot show the current terminal state (prompts, errors, etc.).

### What the new tool needs

The `send_dark_factory_input` tool should:
1. Validate the session exists and is alive (not EXITED)
2. Use `dump-screen` to read current terminal state (last N lines)
3. Return the screen content so the bot can make informed decisions
4. Accept input text and send it via `write-chars` + `write 13`

---

## 6. Command Reference Summary

| Action | Command |
|--------|---------|
| Send text + Enter | `zellij -s NAME action write-chars "text" && zellij -s NAME action write 13` |
| Send just Enter | `zellij -s NAME action write 13` |
| Send Ctrl+C | `zellij -s NAME action write 3` |
| Send Escape | `zellij -s NAME action write 27` |
| Read screen | `zellij -s NAME action dump-screen /tmp/out.txt` |
| Read full scrollback | `zellij -s NAME action dump-screen --full /tmp/out.txt` |
| List sessions | `zellij list-sessions --no-formatting` |
| Check session exists | `zellij list-sessions --short \| grep -q "^NAME$"` |
| Check session alive | `zellij list-sessions --no-formatting \| grep "NAME" \| grep -qv "EXITED"` |

## Sources

- [Zellij CLI Actions Reference](https://zellij.dev/documentation/cli-actions)
- [Zellij Session Management Tutorial](https://zellij.dev/tutorials/session-management/)
- [Zellij Commands Documentation](https://zellij.dev/documentation/commands.html)
- [Controlling Zellij through CLI](https://zellij.dev/documentation/controlling-zellij-through-cli.html)
- [zellij issue #4535 — Actions silently fail with --session on detached sessions](https://github.com/zellij-org/zellij/issues/4535)
- [zellij discussion #2228 — Sending enter with write/write-chars](https://github.com/zellij-org/zellij/discussions/2228)
- [zellij discussion #2704 — Send commands to specific pane](https://github.com/zellij-org/zellij/discussions/2704)
- [zellij issue #1446 — Improve dump-screen action](https://github.com/zellij-org/zellij/issues/1446)
- [Claude Code Permissions Documentation](https://code.claude.com/docs/en/permissions)
- [Claude Code CLI Reference](https://code.claude.com/docs/en/cli-reference)
- [Claude Code --permission-prompt-tool feature request #1175](https://github.com/anthropics/claude-code/issues/1175)
- [Claude Code auto-accept permissions guide](https://claudelog.com/mechanics/auto-accept-permissions/)
- [Claude Code permission modes toggle guide](https://claudefa.st/blog/guide/development/permission-management)
