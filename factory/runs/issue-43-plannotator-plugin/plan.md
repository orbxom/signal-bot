# Plannotator Plugin for Dark Factory Review Steps — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Document plannotator as a dark factory dependency and verify end-to-end functionality including PATH availability in non-interactive shell contexts.

**Architecture:** Plannotator v0.8.2 is already installed at user scope with an ExitPlanMode hook that automatically opens the review UI in the browser when Claude exits plan mode. The dark factory skill already references this at Step 5. The remaining work is documentation and verification.

**Tech Stack:** Claude Code plugins, plannotator CLI, markdown documentation

---

### Task 1: Document plannotator in CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` (add bullet under "### Prerequisites")

**Step 1: Add plannotator documentation to CLAUDE.md**

Add a new bullet under "Running Locally > Prerequisites" (after the "Either signal-cli..." bullet, before "### Test Mode"). Lead with behavior, then configuration:

```markdown
- Plannotator plugin installed (`/plugin install plannotator@plannotator`) — required for dark factory human review steps. When Claude uses `EnterPlanMode` and the human exits plan mode, the plannotator ExitPlanMode hook automatically opens an interactive review UI in the browser where the plan can be annotated, approved, or sent back for changes. Requires `~/.local/bin` in PATH (including for non-interactive shells used by bot-spawned dark factory sessions). Environment variables:
  - `PLANNOTATOR_REMOTE=1` — for remote/SSH sessions (uses fixed port 19432, skips browser auto-open). Do not use with concurrent dark factory sessions (port conflict).
  - `PLANNOTATOR_PORT=<port>` — override default port (random locally)
  - `PLANNOTATOR_BROWSER=<path>` — custom browser executable
```

**Step 2: Verify CLAUDE.md is valid markdown**

Run: `head -80 CLAUDE.md`
Visually confirm the new section is well-placed and properly formatted.

**Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document plannotator plugin as dark factory prerequisite"
```

---

### Task 2: Verify plannotator binary, hook, and PATH availability

**Files:** None modified — verification only, results written to run artifacts

**Step 1: Verify plannotator binary is in PATH (current session)**

Run: `which plannotator`
Expected: `/home/zknowles/.local/bin/plannotator`

**Step 2: Verify plannotator binary is in PATH (non-interactive shell)**

Run: `bash -c 'which plannotator'`
Expected: `/home/zknowles/.local/bin/plannotator`

This simulates the environment that bot-spawned dark factory sessions use (via `kitty` + `zellij` + `bash -c "claude ..."`). If this fails, `~/.local/bin` needs to be added to PATH in a config that non-interactive shells source (e.g., `~/.bashrc` or `/etc/environment`).

**Step 3: Verify plugin is enabled in user settings**

Run: `grep plannotator ~/.claude/settings.json`
Expected: `"plannotator@plannotator": true` in enabledPlugins

**Step 4: Verify hook configuration**

Run: `cat ~/.claude/plugins/cache/plannotator/plannotator/*/hooks/hooks.json`
Expected: Hook with matcher `ExitPlanMode` and command `plannotator`

**Step 5: Write verification results**

Write all verification output (pass/fail for each check) to `factory/runs/issue-43-plannotator-plugin/verification.log`

---

## Verification Plan

This is a documentation-only change — no bot source code is modified. There are no meaningful automated tests for plannotator integration since plan mode is a Claude Code CLI feature, not something the bot's message handler invokes.

1. **Existing tests:** Run `npm test`, `npm run lint`, `npm run check` to confirm no regressions (should pass trivially since only markdown is changed)
2. **Binary/hook verification:** Task 2 above — confirms plannotator is installed, enabled, hooked, and available in both interactive and non-interactive shell contexts
3. **Manual end-to-end:** The true test is running a dark factory session, reaching Step 5 (human checkpoint), and confirming plannotator opens in the browser. This happens naturally in the current pipeline run at Stage 1 Step 5.

---

## Revisions

**Changes from v1 based on devil's advocate review:**

1. **Dropped Task 2 (plannotator-annotate in Step 5):** The ExitPlanMode hook already opens the plannotator UI at exactly the right moment. Adding an explicit `/plannotator-annotate` call before `EnterPlanMode` would create two browser popups for one review step — confusing UX.

2. **Dropped Task 3 (plannotator-review in Stage 7):** YAGNI. The issue mentions "plan review, devil's advocate" as review steps, not code review. Adding `/plannotator-review` to Stage 7 is scope creep. File a separate issue if wanted.

3. **Restructured CLAUDE.md content:** Now leads with behavior (what plannotator does during dark factory runs) rather than environment variables. Added PATH requirement for non-interactive shells and PLANNOTATOR_REMOTE concurrency warning.

4. **Enhanced PATH verification:** Added `bash -c 'which plannotator'` check to verify non-interactive shell PATH inheritance, addressing the risk that bot-spawned dark factory sessions might not find the binary.

5. **Honest test strategy:** Relabeled from "Test Strategy" to "Verification Plan" and acknowledged that plannotator cannot be tested via mock integration tests. The true test is manual (the current pipeline run itself).

**Dismissed concerns:**
- None — all 8 concerns from the devil's advocate were valid and addressed.
