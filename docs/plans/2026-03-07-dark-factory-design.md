# Dark Software Factory — Design Document

## Overview

A conversation-driven automation pipeline that turns Signal messages into merged PRs. The human stays in the loop at checkpoints, but Claude does the heavy lifting between them.

## Pipeline Flow

```
Signal message ("claude: I want feature X")
  -> Bot structures request, creates GitHub issue with `claude-work` label
  -> Human tells Claude "work on issue #N"
  -> STAGE 1 — PLAN
  -> STAGE 2 — BUILD
  -> STAGE 3 — TEST
  -> STAGE 4 — SIMPLIFY
  -> STAGE 5 — PR
  -> STAGE 6 — REVIEW
```

## Architecture Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Runner model | CLI/file-based | No GH Actions minutes; fully offline; any trigger produces same event shape |
| Orchestration | Conversation-driven | Human directs, Claude executes; learn the pattern before automating |
| Stage handoff | Sequential with checkpoints | Human approves before proceeding to next stage |
| Model | Opus throughout | Maximum quality at every stage |
| Agent teams | Planning stage only | Most value from catching bad assumptions early |
| Skill type | Rigid | Learning tool; full process every time |
| Scope (v1) | Signal-to-PR | Full pipeline through draft PR, all conversation-driven |

## Directory Structure

```
factory/
  runs/
    <run-id>/              # e.g., "issue-42"
      event.json           # Trigger metadata
      research.md          # Agent team findings
      plan.md              # Implementation plan
      plan-review.md       # Devil's advocate feedback + revisions
      build.log            # Implementation progress notes
      test.log             # Test suite results
      simplify.log         # Simplify pass changes
      review.md            # Final code review findings
      status.json          # Stage tracking
  templates/
    event.json             # Reference event shape
```

### event.json

```json
{
  "source": "signal",
  "issueNumber": 42,
  "issueUrl": "https://github.com/orbxom/signal-bot/issues/42",
  "title": "Add timezone support for reminders",
  "description": "User wants reminders to respect per-group timezones",
  "acceptanceCriteria": [
    "Reminders fire at the correct local time",
    "Users can set timezone per group"
  ],
  "requestedBy": "+61400111222",
  "createdAt": "2026-03-06T10:00:00Z"
}
```

### status.json

```json
{
  "runId": "issue-42",
  "currentStage": "plan",
  "stages": {
    "plan": { "status": "complete", "completedAt": "..." },
    "build": { "status": "in-progress", "startedAt": "..." },
    "test": { "status": "pending" },
    "simplify": { "status": "pending" },
    "pr": { "status": "pending" },
    "review": { "status": "pending" }
  }
}
```

## Stage Details

### Stage 1 — PLAN

**Step 1 — Research sprint** (parallel subagents):
- Codebase analyst: reads relevant source files, identifies what needs to change
- Docs researcher: uses context7 for up-to-date library documentation
- Prior art reviewer: checks existing plans, recent commits, open issues

All write findings to `research.md`.

**Step 2 — Plan drafting** (main agent):
- Synthesizes research into implementation plan using `writing-plans` skill
- Produces `plan.md`: goal, approach, file changes, test strategy, acceptance criteria mapped to tasks

**Step 3 — Devil's advocate review** (subagent):
- Reads plan and pokes holes: missing edge cases, unnecessary complexity, YAGNI violations, breakage risks
- Writes critique to `plan-review.md`

**Step 4 — Plan revision** (main agent):
- Addresses valid critique, dismisses invalid concerns with reasoning
- Updates `plan.md` with final version

**Step 5 — Human checkpoint**:
- Present plan with summary of devil's advocate findings and how they were addressed
- Human approves, requests changes, or scraps it

### Stage 2 — BUILD

- Create isolated git worktree using `using-git-worktrees` skill
- Follow plan task-by-task using `test-driven-development` skill
- Progress updates at natural milestones
- Feature branch: `feature/issue-<N>-<slug>`

### Stage 3 — TEST

- Run full test suite, lint, type check
- Capture results to `test.log`
- If failures: diagnose with `systematic-debugging` skill, fix, re-run
- Checkpoint only if something surprising — otherwise report "all green"

### Stage 4 — SIMPLIFY

- Run `simplify` skill on all changed files
- Capture changes to `simplify.log`
- Re-run tests to confirm nothing broke

### Stage 5 — PR

- Run `verification-before-completion` skill
- Create draft PR with structured summary
- Link back to GitHub issue

### Stage 6 — REVIEW

- Run `requesting-code-review` skill
- Clean: mark PR ready for review, tell human it's good to merge
- Issues found: leave as draft, post findings as comment

## GitHub Issue Format

The bot creates structured, machine-actionable issues:

```markdown
## Task
<what the user asked for, cleaned up>

## Context
<relevant details gathered from conversation>

## Acceptance Criteria
- [ ] Criterion 1
- [ ] Criterion 2

---
_Requested via Signal by +61400111222_
```

Labels: `feature-request`, `claude-work`

## Skill

A rigid orchestrator skill at `.claude/skills/dark-factory.md` defines the exact stage sequence, checkpoint protocol, artifact requirements, and which skills to chain at each stage.

## Learning Track (Future Levels)

| Level | Orchestration | Teaches |
|-------|--------------|---------|
| 1 (v1) | Conversation-driven | Skills, agent teams, pipeline thinking, checkpoint discipline |
| 2 | `factory` CLI | Codifying workflows, prompt engineering for automation |
| 3 | Event-driven (GH polling/webhooks) | Event routing, autonomous agents, trust boundaries |
| 4 | Model tiering (Opus plan, Sonnet build) | Cost optimization, plan quality as forcing function |

Each level builds on the previous. The `factory/runs/` directory and artifact format stay the same — only the orchestration layer changes.
