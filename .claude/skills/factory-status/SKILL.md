---
name: factory-status
description: Show the status of all dark factory runs, cross-referenced with git branches, worktrees, and GitHub PRs. Use when the user asks about factory runs, dark factory status, "what runs are active", "show me the factory", "cross reference runs", "what needs cleanup", or anything about the state of dark factory pipeline runs. Also trigger when the user asks about stale branches or orphan worktrees in the context of factory work.
---

# Factory Status — Dark Factory Run Overview

This skill produces a comprehensive status report of all dark factory runs by cross-referencing four data sources: run artifacts, git branches, git worktrees, and GitHub PRs.

## How to gather the data

Collect all of the following in parallel where possible:

### 1. Run artifacts
For each directory in `factory/runs/*/`:
- Read `status.json` — current stage, per-stage status
- Read `event.json` — issue number, title, mode, creation date

### 2. Git state
- `git branch -a` — all local and remote branches
- `git worktree list` — active worktrees and their branches
- `git branch --merged master` — which branches are already merged locally

### 3. GitHub PRs
- `gh pr list --state merged --json number,title,headRefName,mergedAt` — merged PRs
- `gh pr list --state open --json number,title,headRefName,url` — open PRs
- `gh pr list --state closed --json number,title,headRefName,closedAt` — closed-not-merged PRs

Use `--jq` to format compactly. Remember: use `gh api` for individual issue/PR details if needed (not `gh issue view` which fails with GraphQL errors).

### 4. Orphan branches
- Local `worktree-agent-*` branches with no corresponding worktree
- Feature branches on origin whose PRs have been merged

## How to present the results

### Primary table
A markdown table with one row per factory run, columns:

| Run | Issue | Title | Run Status | Merged PR | Branch (local/remote) | Worktree | Open PR |

**Run Status** should reflect reality, not just what `status.json` says. If the PR is merged but status.json says "in-progress", flag the inconsistency.

### Findings section
After the table, list issues found:

- **Status inconsistencies** — runs where status.json doesn't match reality (e.g., PR merged but status says "building")
- **Stale branches** — branches on origin or local whose PRs are already merged (safe to delete)
- **Orphan worktrees** — worktrees for completed/merged runs that should be cleaned up
- **Orphan agent branches** — `worktree-agent-*` branches with no worktree or run
- **Genuinely in-progress runs** — runs that are actually active, with their current stage and what's next
- **Stale non-factory branches** — feature branches not associated with any factory run

### Summary line
End with a one-line summary: "N complete, N in-progress, N stuck, N abandoned. N branches to clean up."

## After presenting

If there are cleanup items, ask the user if they want you to clean them up (delete stale branches, remove orphan worktrees, fix stale status.json files). Don't act without confirmation — branch deletion and worktree removal affect shared state.
