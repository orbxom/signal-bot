---
name: dark-factory
description: Use when the user says "work on issue #N", "dark factory", "run the pipeline", or asks you to plan and implement a GitHub issue end-to-end. Also use when the user has an existing plan file they want to run through the pipeline, with or without a GitHub issue.
---

# Dark Factory — Orchestrator Skill

This is a RIGID skill. Follow every stage in order. Do not skip stages. Do not take shortcuts. The human must approve at every checkpoint before you proceed.

**Context preservation rule:** The orchestrator (you) MUST NOT write code directly. All code writing, editing, debugging, and refactoring MUST be delegated to subagents or agent teams. The orchestrator's job is to manage the pipeline, make decisions, coordinate agents, and communicate with the human. This keeps the orchestrator's context clean and focused.

## Trigger

The user says something like:
- "work on issue #42" — full pipeline (has issue, no plan)
- "dark factory with plan docs/plans/foo.md" — has plan, no issue
- "work on issue #42, plan is at plan.md" — has both issue and plan
- "resume issue-42" — resume interrupted run

## Entry Modes

Detect what the user provides and select the mode:

| Mode | Has Issue | Has Plan | What Happens |
|------|-----------|----------|--------------|
| Full | Yes | No | Fetch issue, full planning pipeline |
| Plan-only | No | Yes | Copy plan, skip issue fetch + plan drafting, run research + review |
| Fast-start | Yes | Yes | Fetch issue, copy plan, skip plan drafting, run research + review |

In all modes, **research, devil's advocate review, plan revision, and human checkpoint still happen**. Only plan drafting (Step 2) is skipped when a plan is provided.

## Prerequisites

Before starting, verify:
1. The `factory/runs/` directory exists (create it if not)
2. The GitHub issue exists and has enough detail to work from (full and fast-start modes only)
3. The plan file exists and is readable (plan-only and fast-start modes only)
4. You are on the `master` branch with a clean working tree

## Stage 0 — INITIALIZE

Determine the entry mode from what the user provided, then initialize accordingly.

### Full mode (issue, no plan)
1. Fetch the GitHub issue details using `gh api repos/orbxom/signal-bot/issues/<N>`
2. Create the run directory: `factory/runs/<run-id>/`
3. Write `event.json` with: source, issueNumber, issueUrl, title, description, acceptanceCriteria, mode ("full"), createdAt
4. Write `status.json` with all stages set to `pending` (plan, build, test, simplify, pr, integration-test, review)
5. Create `diary.md` with header `# Diary — <run-id>`
6. Update `status.json` to set current stage to `plan`

**Diary:** Append entry — "Initialized. Mode: full. Issue #N: <title>."

### Plan-only mode (plan, no issue)
1. Choose a run ID from the plan filename or content (e.g., `plan-<slug>`)
2. Create the run directory: `factory/runs/<run-id>/`
3. Copy the user's plan file to `factory/runs/<run-id>/plan.md`
4. Write `event.json` synthesized from the plan content: source ("local"), title, description, acceptanceCriteria (extracted from plan), mode ("plan-only"), createdAt. No issueNumber or issueUrl.
5. Write `status.json` with all stages set to `pending`
6. Create `diary.md` with header `# Diary — <run-id>`
7. Update `status.json` to set current stage to `plan`

**Diary:** Append entry — "Initialized. Mode: plan-only. Plan: <filename>. Title: <title>."

### Fast-start mode (issue + plan)
1. Fetch the GitHub issue details using `gh api repos/orbxom/signal-bot/issues/<N>`
2. Create the run directory: `factory/runs/<run-id>/`
3. Copy the user's plan file to `factory/runs/<run-id>/plan.md`
4. Write `event.json` with: source, issueNumber, issueUrl, title, description, acceptanceCriteria, mode ("fast-start"), createdAt
5. Write `status.json` with all stages set to `pending`
6. Create `diary.md` with header `# Diary — <run-id>`
7. Update `status.json` to set current stage to `plan`

**Diary:** Append entry — "Initialized. Mode: fast-start. Issue #N: <title>. Plan: <filename>."

**Announce:** "Initialized run for <run-id>. Mode: <mode>. Starting planning stage."

## Stage 1 — PLAN

### Step 1: Research Sprint

Dispatch parallel subagents (use `dispatching-parallel-agents` skill). Each subagent should check what skills they have available. Three agents:

**Codebase Analyst:**
- Read all files relevant to the issue (or plan, if no issue)
- Map out what needs to change and what's affected
- Identify integration points and risk areas
- Write findings as structured notes

**Docs Researcher:**
- Use context7 MCP to look up documentation for any libraries or APIs involved
- Focus on APIs the implementation will use
- Write findings as structured notes

**Prior Art Reviewer:**
- Check `docs/plans/` for related designs
- Check recent git history for related changes
- Check open GitHub issues for conflicts or related work
- Write findings as structured notes

Combine all findings into `factory/runs/<run-id>/research.md`.

**This step always runs**, even when a plan is provided. Research validates the plan against the current state of the codebase.

**Diary:** Append entry when dispatching agents, then another when research completes (summarize key findings in one line).

### Step 2: Plan Drafting

**Skip this step if `plan.md` already exists in the run directory** (plan-only or fast-start mode). Jump to Step 3.

Use the `writing-plans` skill to create the implementation plan. The plan MUST include:
- Goal (tied to acceptance criteria from the issue)
- Approach (architecture decisions, trade-offs considered)
- File changes (which files are created/modified/deleted)
- Test strategy (what tests, TDD approach)
- Tasks (ordered, each small enough for one focused session)

Write to `factory/runs/<run-id>/plan.md`.

**Diary:** Append entry — "Plan drafted. <N> tasks, <approach summary>." (Skip if step was skipped; note "Plan provided by user, skipping drafting." instead.)

### Step 3: Devil's Advocate Review

Spawn a subagent with this mandate:
- Read the plan and research
- Challenge every decision: Is this too complex? Are we missing edge cases? Does this violate YAGNI? Could this break existing functionality? Is the test strategy sufficient?
- Be constructive but thorough
- Write critique to `factory/runs/<run-id>/plan-review.md`

**Diary:** Append entry — "Devil's advocate: <N> concerns raised (<brief list>)."

### Step 4: Plan Revision

- Review the devil's advocate critique
- Address valid concerns by updating the plan
- Dismiss invalid concerns with clear reasoning
- Update `factory/runs/<run-id>/plan.md` with the final version
- Add a "Revisions" section at the bottom noting what changed and why

**Diary:** Append entry — "Plan revised. Addressed: <concerns addressed>. Dismissed: <concerns dismissed>."

### Step 5: Human Checkpoint

**STOP. Switch to plan mode using `EnterPlanMode`.**

In your plan mode message, present:
- Summary of what you're building and why
- Key architectural decisions
- What the devil's advocate raised and how you addressed it
- The full plan (or a link to `factory/runs/<run-id>/plan.md`)

This launches the Plannotator UI where the human can review and annotate the plan interactively. When they approve exiting plan mode, proceed to the next stage.

**Do NOT proceed until the human explicitly approves.**

**Diary:** Append entry — "Human approved plan. Moving to BUILD."

Update `status.json`: plan -> complete.

## Stage 2 — BUILD

1. Use the `using-git-worktrees` skill to create an isolated worktree
2. Create feature branch: `feature/<run-id>-<slug>` (slug from title, lowercase, hyphens)
3. **Delegate all implementation to subagents.** Use the `subagent-driven-development` or `dispatching-parallel-agents` skill to break the plan into independent tasks and dispatch agents to implement them. Each subagent should:
   - Be given the relevant section of the plan and necessary file paths
   - Use the `test-driven-development` skill
   - Work in the worktree created in step 1
   - Check what skills they have available
4. As subagents complete, review their summaries (not their full code output) and log progress to `factory/runs/<run-id>/build.log`
5. Report progress at natural milestones: "Completed task 3/7 — <description>"

**Do NOT read or write implementation code yourself.** Only read subagent summaries and status.

**Diary:** Append entry when worktree/branch is created. Append an entry after each subagent completes a task — "Task N/M done — <brief description>. Tests: pass/fail." Append a summary entry when all tasks are done.

Update `status.json`: build -> complete.

**Announce:** "Implementation complete. Moving to testing."

## Stage 3 — TEST

1. Run the full test suite: `cd bot && npm test`
2. Run lint: `cd bot && npm run lint`
3. Run format/check: `cd bot && npm run check`
4. Capture all output to `factory/runs/<run-id>/test.log`
5. If any failures:
   - **Dispatch a subagent** to diagnose and fix. The subagent should use the `systematic-debugging` skill, fix the issue, and re-run all checks.
   - Review the subagent's summary and log the debugging process to `test.log`
   - **Do NOT debug or fix code yourself.** Only dispatch agents and review their results.
6. If failures persist after 3 subagent attempts:
   - **STOP. Checkpoint with human.** Explain what's failing and what you've tried.

**Diary:** Append entry with initial test/lint/check results (pass, or list failures). After each debug subagent attempt, append — "Debug attempt N: <what was tried>, result: <pass/fail>." When all pass (or escalating), append final entry.

Update `status.json`: test -> complete.

**Announce:** "All tests passing. Moving to simplify."

## Stage 4 — SIMPLIFY

1. **Dispatch a subagent** to run the `simplify` skill on all changed files
2. The subagent should log what was changed to `factory/runs/<run-id>/simplify.log`
3. The subagent should re-run tests to confirm nothing broke
4. If tests break, the subagent should revert the simplify changes and note it in the log
5. Review the subagent's summary. **Do NOT read or edit code yourself.**

**Diary:** Append entry — "Simplify: <summary of changes or 'no changes needed'>. Tests: pass/fail."

Update `status.json`: simplify -> complete.

**Announce:** "Simplification complete. Moving to PR creation."

## Stage 5 — PR

1. Use the `verification-before-completion` skill — confirm tests pass, build works
2. Create a draft PR using `gh pr create --draft` with:
   - Title: short description (under 70 chars)
   - Body:
     ```
     ## Summary
     <what changed and why, 2-3 bullets>

     Closes #<issue-number> (omit if plan-only mode)

     ## Changes
     <list of files changed with brief description>

     ## Test Plan
     - [ ] All existing tests pass
     - [ ] New tests cover acceptance criteria
     - [ ] <specific test scenarios>

     ## Factory Run
     Artifacts: `factory/runs/<run-id>/`
     ```
3. **Verify issue-PR linkage** (skip for plan-only mode — no issue to link):
   Spawn a subagent to confirm the GitHub issue will auto-close when the PR merges:
   - Fetch the PR via `gh api repos/orbxom/signal-bot/pulls/<number>` and verify the body contains `Closes #<issue-number>`
   - Fetch the issue via `gh api repos/orbxom/signal-bot/issues/<issue-number>` and check for a cross-reference from the PR
   - If linkage is missing, fix it by updating the PR body: `gh api -X PATCH repos/orbxom/signal-bot/pulls/<number> -f body="<updated body with Closes #N>"`
   - Report whether linkage was verified as-is or had to be fixed
4. Log PR URL to `factory/runs/<run-id>/pr-url.txt`

**Diary:** Append entry — "PR #<number> created: <title>. Issue linkage: <verified/fixed/skipped>."

Update `status.json`: pr -> complete.

**Announce:** "Draft PR created: <url>. Moving to integration testing."

## Stage 6 — INTEGRATION TEST

Verify the feature actually works end-to-end using the mock signal server.

1. Use the `mock-signal-testing` skill to start the mock server and bot
2. Design test messages that exercise the feature built in this run (based on the plan's acceptance criteria)
3. Send each test message via the mock server's `queueMessage` RPC and verify the bot responds correctly by checking the log output
4. Log test messages, expected outcomes, and actual outcomes to `factory/runs/<run-id>/integration-test.log`
5. If a test fails:
   - **Dispatch a subagent** to diagnose and fix the issue. Do NOT fix code yourself.
   - The subagent should run unit tests after fixing to ensure nothing else broke
   - Re-run the failing integration test
   - Log what went wrong and what the fix was
6. If failures persist after 3 fix attempts:
   - **STOP. Checkpoint with human.** Explain what's failing and what you've tried.
7. **Save learnings as memories**: After fixing any integration test failure, write a memory to `/home/zknowles/.claude/projects/-home-zknowles-personal-signal-bot/memory/` documenting:
   - What went wrong (the symptom)
   - Why it went wrong (root cause)
   - How it was fixed (the solution)
   - This prevents the same mistakes from recurring in future pipeline runs
8. Clean up: kill mock server and bot processes

**Diary:** Append entry for each test case — "Test: '<message>' — expected: <X>, actual: <Y>, result: pass/fail." After fix attempts, append — "Fix attempt N: <what was tried>, result: <pass/fail>." Final entry when all pass (or escalating).

Update `status.json`: integration-test -> complete.

**Announce:** "Integration testing complete. Moving to review."

## Stage 7 — REVIEW

1. Use the `requesting-code-review` skill on the PR
2. If review is clean:
   - Mark PR ready for review: `gh pr ready <number>`
   - **Tell the human:** "PR is ready for review. Everything looks clean. Ready to merge?"
3. If review finds issues:
   - Leave PR as draft
   - Post findings as a PR comment
   - Write findings to `factory/runs/<run-id>/review.md`
   - **Tell the human:** "Review found issues. See PR comments. Want me to address them?"

**Diary:** Append entry — "Review: <clean/N issues found>." If clean: "Run complete. PR ready for merge." If issues: "Returning to BUILD to address review feedback."

Update `status.json`: review -> complete (or back to build if fixing issues).

## Resuming a Run

If a conversation is interrupted, the human can say "resume issue-42" (or "resume plan-foo" for plan-only runs). To resume:

1. Read `factory/runs/<run-id>/status.json`
2. Read `factory/runs/<run-id>/event.json` to determine the entry mode
3. Read `factory/runs/<run-id>/diary.md` to understand what happened, decisions made, and current context
4. Find the first non-complete stage
5. Announce: "Resuming <run-id> from <stage> stage. Mode: <mode>. Last activity: <last diary entry summary>."
6. Continue from that stage, respecting the original entry mode

**Diary:** Append entry — "Resumed from <stage>. Previous session ended at: <last entry context>."

## Rules

- **Never skip a stage.** Even for "trivial" changes.
- **Never proceed past a checkpoint without human approval.**
- **Always update status.json** when entering and completing a stage.
- **Always append to diary.md** at stage transitions and mid-stage milestones. Each entry: one line with timestamp, what happened, key decisions or outcomes. Brief but meaningful — enough for a new conversation to resume without reading full artifacts.
- **Always write artifacts** to the run directory, not just to stdout.
- **Never write or edit code directly.** The orchestrator delegates ALL code work (implementation, debugging, refactoring, simplification) to subagents. You may read subagent summaries, run shell commands (tests, git), and write pipeline artifacts (status.json, logs, event.json), but never use Read/Edit on source code files. This keeps your context clean for orchestration.
- **Encourage subagents to check their available skills** when spawning them.
- **Use `gh api` instead of `gh issue view`** — the latter fails with GraphQL errors.
