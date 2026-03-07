---
name: factory-cleanup
description: Clean up a completed dark factory run — merge its PR, delete branches, remove worktrees, and pull master. Use when the user says "clean up issue-41", "merge and clean up the factory run", "finish up issue-42", "close out run issue-33", or anything about finalizing/cleaning a specific completed factory run. Do NOT use for batch cleanup of multiple runs — this is for one run at a time.
---

# Factory Cleanup — Finalize a Completed Run

Merges the PR, deletes branches, removes the worktree, and pulls master for a single completed dark factory run. The goal is to reach a clean end state regardless of what's already been done — idempotent by design.

## Identify the run

The user will reference an issue number or run ID. Find the matching directory under `factory/runs/`. If ambiguous, list matches and ask.

## Verify readiness

Read `status.json` from the run directory. Every stage must be `complete`. If any stage is not complete, stop and tell the user which stages are incomplete — don't proceed with partial cleanup.

## Read run context

Read `event.json` for the issue number and `pr-url.txt` for the PR number. You need:
- The PR number (from `pr-url.txt` or by searching open PRs)
- The branch name (convention: `feature/<run-id>` or similar — check `git branch -a | grep <run-id>`)
- The worktree path (from `git worktree list`)

Gather all three in parallel.

## Execute cleanup

Run these steps in order. Each step is resilient to already-done state.

### 1. Merge the PR

Check if the PR is already merged first:
```bash
gh api repos/orbxom/signal-bot/pulls/<number> --jq '.merged'
```

- If `true`: skip, already merged.
- If `false`: merge it:
  ```bash
  gh api -X PUT repos/orbxom/signal-bot/pulls/<number>/merge -f merge_method=merge
  ```
  If merge fails (conflicts, checks), stop and tell the user.

### 2. Remove the worktree

Check `git worktree list` for a worktree on the run's branch.

- If found: `git worktree remove <path>`
- If not found: skip, already gone.
- If the remove fails with "contains modified or untracked files", tell the user and ask before using `--force`.

### 3. Delete the local branch

```bash
git branch -D <branch-name> 2>/dev/null
```

If the branch doesn't exist locally, that's fine — skip it.

### 4. Delete the remote branch

```bash
git push origin --delete <branch-name> 2>/dev/null
```

If already gone (deleted by PR merge or manually), that's fine — skip it. The `gh api merge` with `--delete-branch` or the PR settings may have already done this.

### 5. Pull master

```bash
git pull origin master
```

This picks up the merge commit.

## Report

Summarize what happened in a short list:

```
Cleanup complete for <run-id>:
- PR #N: merged (or: already merged)
- Worktree: removed (or: already gone)
- Local branch: deleted (or: already gone)
- Remote branch: deleted (or: already gone)
- Master: updated to <short-sha>
```
