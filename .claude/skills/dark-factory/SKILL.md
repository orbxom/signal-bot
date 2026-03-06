---
name: dark-factory
description: Use when the user says "work on issue #N", "dark factory", "run the pipeline", or asks you to plan and implement a GitHub issue end-to-end. This is the orchestrator for the full plan-build-test-simplify-PR-review pipeline.
---

# Dark Factory — Orchestrator Skill

This is a RIGID skill. Follow every stage in order. Do not skip stages. Do not take shortcuts. The human must approve at every checkpoint before you proceed.

## Trigger

The user says something like:
- "work on issue #42"
- "dark factory issue 42"
- "run the pipeline for issue 42"

## Prerequisites

Before starting, verify:
1. The `factory/runs/` directory exists (create it if not)
2. The GitHub issue exists and has enough detail to work from
3. You are on the `master` branch with a clean working tree

## Stage 0 — INITIALIZE

1. Fetch the GitHub issue details using `gh api repos/orbxom/signal-bot/issues/<N>`
2. Create the run directory: `factory/runs/issue-<N>/`
3. Write `event.json` with: source, issueNumber, issueUrl, title, description, acceptanceCriteria, createdAt
4. Write `status.json` with all stages set to `pending`
5. Update `status.json` to set current stage to `plan`

**Announce:** "Initialized run for issue #N. Starting planning stage."

## Stage 1 — PLAN

### Step 1: Research Sprint

Dispatch parallel subagents (use `dispatching-parallel-agents` skill). Each subagent should check what skills they have available. Three agents:

**Codebase Analyst:**
- Read all files relevant to the issue
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

Combine all findings into `factory/runs/issue-<N>/research.md`.

### Step 2: Plan Drafting

Use the `writing-plans` skill to create the implementation plan. The plan MUST include:
- Goal (tied to acceptance criteria from the issue)
- Approach (architecture decisions, trade-offs considered)
- File changes (which files are created/modified/deleted)
- Test strategy (what tests, TDD approach)
- Tasks (ordered, each small enough for one focused session)

Write to `factory/runs/issue-<N>/plan.md`.

### Step 3: Devil's Advocate Review

Spawn a subagent with this mandate:
- Read the plan and research
- Challenge every decision: Is this too complex? Are we missing edge cases? Does this violate YAGNI? Could this break existing functionality? Is the test strategy sufficient?
- Be constructive but thorough
- Write critique to `factory/runs/issue-<N>/plan-review.md`

### Step 4: Plan Revision

- Review the devil's advocate critique
- Address valid concerns by updating the plan
- Dismiss invalid concerns with clear reasoning
- Update `factory/runs/issue-<N>/plan.md` with the final version
- Add a "Revisions" section at the bottom noting what changed and why

### Step 5: Human Checkpoint

**STOP. Present to the human:**
- Summary of what you're building and why
- Key architectural decisions
- What the devil's advocate raised and how you addressed it
- The full plan (or a link to it)

Ask: "Plan is ready. Approve, request changes, or scrap?"

**Do NOT proceed until the human explicitly approves.**

Update `status.json`: plan -> complete.

## Stage 2 — BUILD

1. Use the `using-git-worktrees` skill to create an isolated worktree
2. Create feature branch: `feature/issue-<N>-<slug>` (slug from issue title, lowercase, hyphens)
3. Use the `test-driven-development` skill to implement the plan task by task
4. Report progress at natural milestones: "Completed task 3/7 — <description>"
5. Log progress notes to `factory/runs/issue-<N>/build.log`

Update `status.json`: build -> complete.

**Announce:** "Implementation complete. Moving to testing."

## Stage 3 — TEST

1. Run the full test suite: `cd bot && npm test`
2. Run lint: `cd bot && npm run lint`
3. Run format/check: `cd bot && npm run check`
4. Capture all output to `factory/runs/issue-<N>/test.log`
5. If any failures:
   - Use the `systematic-debugging` skill to diagnose
   - Fix the issue
   - Re-run all checks
   - Log the debugging process to `test.log`
6. If failures persist after 3 attempts:
   - **STOP. Checkpoint with human.** Explain what's failing and what you've tried.

Update `status.json`: test -> complete.

**Announce:** "All tests passing. Moving to simplify."

## Stage 4 — SIMPLIFY

1. Use the `simplify` skill on all changed files
2. Log what was changed to `factory/runs/issue-<N>/simplify.log`
3. Re-run tests to confirm nothing broke
4. If tests break, revert the simplify changes and note it in the log

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

     Closes #<issue-number>

     ## Changes
     <list of files changed with brief description>

     ## Test Plan
     - [ ] All existing tests pass
     - [ ] New tests cover acceptance criteria
     - [ ] <specific test scenarios>

     ## Factory Run
     Artifacts: `factory/runs/issue-<N>/`
     ```
3. Log PR URL to `factory/runs/issue-<N>/pr-url.txt`

Update `status.json`: pr -> complete.

**Announce:** "Draft PR created: <url>. Moving to review."

## Stage 6 — REVIEW

1. Use the `requesting-code-review` skill on the PR
2. If review is clean:
   - Mark PR ready for review: `gh pr ready <number>`
   - **Tell the human:** "PR is ready for review. Everything looks clean. Ready to merge?"
3. If review finds issues:
   - Leave PR as draft
   - Post findings as a PR comment
   - Write findings to `factory/runs/issue-<N>/review.md`
   - **Tell the human:** "Review found issues. See PR comments. Want me to address them?"

Update `status.json`: review -> complete (or back to build if fixing issues).

## Resuming a Run

If a conversation is interrupted, the human can say "resume issue-42". To resume:

1. Read `factory/runs/issue-42/status.json`
2. Find the first non-complete stage
3. Announce: "Resuming issue-42 from <stage> stage."
4. Continue from that stage

## Rules

- **Never skip a stage.** Even for "trivial" changes.
- **Never proceed past a checkpoint without human approval.**
- **Always update status.json** when entering and completing a stage.
- **Always write artifacts** to the run directory, not just to stdout.
- **Encourage subagents to check their available skills** when spawning them.
- **Use `gh api` instead of `gh issue view`** — the latter fails with GraphQL errors.
