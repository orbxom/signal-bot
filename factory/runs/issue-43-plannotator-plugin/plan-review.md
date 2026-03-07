# Devil's Advocate Review — issue-43-plannotator-plugin

**Reviewer:** Devil's Advocate subagent
**Date:** 2026-03-07
**Verdict:** Plan needs revision. Several concerns ranging from scope creep to a redundant UI flow that will confuse the human operator.

---

## Concerns

### 1. Redundant UI: /plannotator-annotate PLUS ExitPlanMode hook creates two popups for one review step

**Severity: HIGH**

The plan's Task 2 proposes this flow for Step 5:

1. Invoke `/plannotator-annotate` on `plan.md` -- opens browser UI
2. Enter plan mode via `EnterPlanMode`
3. Human reads the plan in plan mode
4. Human exits plan mode -- ExitPlanMode hook fires -- opens browser UI *again*

That is two separate plannotator browser windows for one review checkpoint. The human will see the plan annotation UI, close it or switch away, then immediately get a *second* plannotator UI from the hook. This is confusing, redundant, and actively worse than the current behavior.

The existing Step 5 already works: `EnterPlanMode` -> human reads plan -> `ExitPlanMode` -> hook fires -> plannotator UI opens. The research itself confirms "Dark factory SKILL.md already references EnterPlanMode + plannotator" and the hook mechanism is working.

**Recommendation:** Drop Task 2 entirely. The ExitPlanMode hook already provides the plannotator UI at exactly the right moment. Adding an explicit `/plannotator-annotate` call *before* that creates UX confusion. If the intent is to let the human annotate the plan *before* the orchestrator presents its summary, that is a different workflow that should be argued for explicitly -- but the issue does not ask for it.

### 2. YAGNI: /plannotator-review in Stage 7 is not requested by the issue

**Severity: HIGH**

The issue's acceptance criteria say:

> "When a dark factory session reaches a human review step (e.g. plan review, devil's advocate), it triggers the plannotator UI to open in the browser"

The examples given are "plan review" and "devil's advocate" -- both are Stage 1 activities. Code review in Stage 7 is never mentioned. The plan is adding a feature (visual code review via plannotator) that nobody asked for.

Furthermore, the `requesting-code-review` skill already exists and handles Stage 7. Adding `/plannotator-review` before it means the human now has *two* review UIs to process at Stage 7 -- the plannotator diff viewer AND whatever the code review skill produces. That is more friction, not less.

**Recommendation:** Drop Task 3 entirely. If `/plannotator-review` in Stage 7 is wanted, it should be its own issue with its own acceptance criteria, not scope-creep bolted onto a "install and configure" issue.

### 3. Scope creep: The issue says "install and configure" but the plugin is already installed

**Severity: HIGH**

The research is unambiguous:

- Plannotator v0.8.2 is installed (2026-02-19)
- Binary is at `/home/zknowles/.local/bin/plannotator`
- Plugin is enabled in `~/.claude/settings.json`
- ExitPlanMode hook is configured and fires
- SKILL.md line 154 already says "This launches the Plannotator UI"

The issue title is "Install plannotator plugin for dark factory review steps." The plugin is already installed. The hook already fires. The dark factory skill already references it. What remains is:

1. Verify it works end-to-end (Task 4 -- the only task that directly addresses a real gap)
2. Document it in CLAUDE.md (Task 1 -- reasonable but minor)

The plan inflates a verification task into four tasks with skill file modifications that introduce the redundancy problems described above.

**Recommendation:** Reduce the plan to two tasks: (1) document plannotator in CLAUDE.md, (2) verify the binary, plugin, hook, and end-to-end flow. Write the verification results. Close the issue. That is what "install and configure" means when the thing is already installed.

### 4. No fallback if plannotator binary is missing or broken in subagent sessions

**Severity: MEDIUM**

The `start_dark_factory` MCP tool (in `bot/src/mcp/servers/darkFactory.ts`) spawns sessions via `kitty` + `zellij` + `claude`. The spawned process inherits `process.env` but with `CLAUDECODE` explicitly cleared (line 154: `env: { ...process.env, CLAUDECODE: '' }`). Whether `~/.local/bin` is in PATH for these sessions depends on the shell profile that `bash -c` loads (or doesn't load).

The plan has no fallback behavior defined. If `plannotator` is not in PATH, the ExitPlanMode hook will fail silently (or error), and the dark factory session will be stuck waiting for human approval that never gets properly surfaced.

The research flags this risk ("PATH in subagents: ~/.local/bin must be in PATH for hook to find plannotator binary") but the plan's Task 4 only verifies the current session's PATH, not the subagent launch path.

**Recommendation:** Task 4 should include a verification step that actually spawns a test subagent (or at minimum runs `bash -c 'which plannotator'` to simulate the non-login shell) to confirm PATH inheritance. The CLAUDE.md documentation should note that `~/.local/bin` must be in PATH for non-interactive shells (e.g., via `~/.bashrc` or `/etc/environment`, not just `~/.profile`).

### 5. Test strategy is inadequate -- plannotator cannot be tested in mock integration tests

**Severity: MEDIUM**

The test strategy says:

> "Integration test: In Stage 6, trigger a plan mode checkpoint in a test session and verify plannotator UI opens in the browser"

This is not something Stage 6 (mock signal testing) can do. Stage 6 uses the mock signal server to send messages and check bot responses. It does not run interactive Claude Code sessions with plan mode. Plan mode is a Claude Code CLI feature, not something the bot's message handler invokes.

Additionally, `npm test` / `npm run lint` / `npm run check` will pass trivially since no bot source code is being modified -- only markdown files. These tests verify nothing about the change.

The only meaningful test is manual: run the dark factory skill, reach Step 5, and confirm the plannotator UI opens. That is a human verification, not an automated test.

**Recommendation:** Be honest that this is a documentation-and-config change with no meaningful automated test coverage. The "test strategy" should be relabeled as "verification plan" and consist entirely of the manual checks in Task 4. Do not pretend Stage 6 integration tests will cover plannotator functionality.

### 6. Bot-spawned dark factory sessions (via start_dark_factory MCP) may not have plannotator

**Severity: MEDIUM**

When the bot spawns a dark factory session via the `start_dark_factory` MCP tool, it creates a kitty terminal running `bash -c "cd '<root>' && claude \"/dark-factory issue N\""`. This is a non-login, non-interactive bash shell. Whether `~/.local/bin` is in PATH depends on how the user's shell is configured.

The plannotator plugin is enabled at user scope (`~/.claude/settings.json`), so Claude Code *should* pick it up. But the hook runs the `plannotator` binary directly (the hooks.json just says `"command": "plannotator"`), so it needs to resolve from PATH.

The plan does not address this scenario at all. If the dark factory is triggered by the bot (e.g., a Signal message saying "work on issue #50"), the resulting session may not have plannotator available.

**Recommendation:** Add explicit verification of the bot-spawned path. At minimum, confirm that `bash -c 'which plannotator'` succeeds. Consider adding the full path (`/home/zknowles/.local/bin/plannotator`) to the hooks.json command, or adding `~/.local/bin` to a system-wide PATH config that non-interactive shells inherit.

### 7. CLAUDE.md is the right place for documentation, but the content is wrong

**Severity: LOW**

Documenting plannotator in CLAUDE.md under "Prerequisites" is reasonable -- it tells future sessions about the dependency. However, the proposed documentation text focuses on environment variables (`PLANNOTATOR_REMOTE`, `PLANNOTATOR_PORT`, `PLANNOTATOR_BROWSER`) that are irrelevant to most sessions. The key information -- that the ExitPlanMode hook fires automatically and opens a review UI -- is more important than port configuration.

**Recommendation:** Lead with what plannotator *does* in the dark factory context ("ExitPlanMode hook opens interactive plan review in the browser"), then mention the environment variables as secondary notes. Also document the prerequisite that `~/.local/bin` must be in PATH.

### 8. Port conflicts with concurrent dark factory runs are unaddressed

**Severity: LOW**

The research notes: "Multiple dark factory runs could collide on ports." The default plannotator behavior uses a random port locally, which mitigates this. But if `PLANNOTATOR_REMOTE=1` is set (fixed port 19432), concurrent sessions will fail.

The plan ignores this entirely.

**Recommendation:** Add a note in the CLAUDE.md documentation that `PLANNOTATOR_REMOTE=1` must not be used when multiple concurrent dark factory sessions are expected. This is a documentation fix, not a code fix, but it should be captured.

---

## Summary

| # | Concern | Severity | Recommendation |
|---|---------|----------|----------------|
| 1 | Two plannotator popups in Step 5 | HIGH | Drop Task 2 -- ExitPlanMode hook already handles it |
| 2 | /plannotator-review in Stage 7 not requested | HIGH | Drop Task 3 -- YAGNI, file separate issue if wanted |
| 3 | Scope creep -- plugin already installed | HIGH | Reduce to verify + document only |
| 4 | No fallback for missing binary in subagents | MEDIUM | Verify non-login shell PATH, document requirement |
| 5 | Test strategy cannot actually test plannotator | MEDIUM | Relabel as manual verification plan |
| 6 | Bot-spawned sessions may lack plannotator | MEDIUM | Verify bash -c PATH, consider absolute path in hook |
| 7 | CLAUDE.md content prioritizes wrong info | LOW | Lead with behavior, not env vars |
| 8 | Port conflicts unaddressed | LOW | Document PLANNOTATOR_REMOTE concurrency limitation |

**Bottom line:** This plan should be cut down to two tasks: (1) document plannotator in CLAUDE.md with correct emphasis, and (2) verify the full chain works -- binary PATH, plugin settings, hook config, and a manual end-to-end test including the non-login shell scenario. Tasks 2 and 3 are scope creep that introduces UX problems.
