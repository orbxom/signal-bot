# Dark Factory Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable the signal bot to create structured, machine-actionable GitHub issues with `claude-work` labels, and set up the factory infrastructure for the dark factory pipeline.

**Architecture:** Three changes: (1) update the GitHub MCP tool to default to `claude-work` label, (2) add a bot skill that teaches Claude how to structure feature requests before creating issues, (3) add gitignore entry for factory run artifacts.

**Tech Stack:** TypeScript, Vitest, MCP server framework (existing)

---

### Task 1: Update GitHub MCP tool default labels

The `create_feature_request` tool currently defaults to `["feature-request"]`. Add `claude-work` so the bot's issues are machine-identifiable.

**Files:**
- Modify: `bot/src/mcp/servers/github.ts:55`
- Test: `bot/tests/githubMcpServer.test.ts`

**Step 1: Write the failing test**

Add a test to `bot/tests/githubMcpServer.test.ts` that verifies the default labels include `claude-work`. Since `create_feature_request` shells out to `gh`, we can't easily integration-test the actual label application. Instead, test at the schema level — verify the tool description mentions the new default.

Actually, the current tests don't mock `gh` — they test error paths (missing args, missing env). The label default is applied in handler code (`line 55`). The simplest test: call the tool with valid args but without a `labels` param, and check the `gh` command fails (since we won't have a real repo) — but inspect the error to confirm it tried. This is already covered by existing patterns.

Instead, this is a one-line code change. No new test needed — existing tests still pass.

**Step 2: Update the default labels**

In `bot/src/mcp/servers/github.ts`, change line 55:

```typescript
// Before:
const labels = Array.isArray(args.labels) ? (args.labels as string[]) : ['feature-request'];

// After:
const labels = Array.isArray(args.labels) ? (args.labels as string[]) : ['feature-request', 'claude-work'];
```

**Step 3: Run tests to verify nothing broke**

Run: `cd bot && npx vitest run tests/githubMcpServer.test.ts`
Expected: All 7 tests pass

**Step 4: Commit**

```bash
git add bot/src/mcp/servers/github.ts
git commit -m "feat: add claude-work to default GitHub issue labels"
```

---

### Task 2: Create feature-request bot skill

The bot needs guidance on how to structure feature requests before calling `create_feature_request`. This follows the same pattern as `dossier-maintenance.md` and `persona-management.md` — a markdown skill file in `bot/src/skills/`.

**Files:**
- Create: `bot/src/skills/feature-requests.md`

**Step 1: Write the skill file**

Create `bot/src/skills/feature-requests.md`:

```markdown
## Feature Request Handling

When a user asks for a new feature, enhancement, or capability that doesn't exist yet, follow this process:

### Recognizing Feature Requests

A message is a feature request when the user:
- Asks for something the bot can't currently do
- Suggests an improvement to existing behavior
- Says "it would be nice if..." or "can you add..."
- Describes a workflow they wish existed

### Process

1. **Acknowledge** that you can't do this yet, but you can help get it built.
2. **Clarify** the request — ask follow-up questions if the request is vague. Understand what they actually want, not just what they said.
3. **Propose** what the feature would look like. Describe it back to them so they can confirm.
4. **Ask permission** before creating the issue: "Want me to create a GitHub issue for this so it can be built?"
5. **Structure the issue** using the format below, then call `create_feature_request`.

### Issue Structure

Compose the `body` parameter with this format:

```
## Task
<clean, concise description of what needs to be built>

## Context
<why the user wants this, any relevant conversation context, how it fits with existing features>

## Acceptance Criteria
- [ ] <specific, testable criterion>
- [ ] <specific, testable criterion>
- [ ] <specific, testable criterion>
```

### Guidelines

- Write acceptance criteria that are specific and testable, not vague ("works well")
- Include context about WHY, not just WHAT — this helps the implementer make good decisions
- Keep the title short and descriptive (under 70 characters)
- Don't over-specify HOW it should be built — focus on the desired behavior
- If the user mentions multiple features, create separate issues for each
```

**Step 2: Verify the skill is loaded by contextBuilder**

The `loadSkillContent()` method in `bot/src/contextBuilder.ts:138-153` reads all `.md` files from the skills directory and sorts them alphabetically. No code change needed — the new file will be picked up automatically.

Run: `cd bot && npx vitest run tests/contextBuilder.test.ts`
Expected: All tests pass

**Step 3: Commit**

```bash
git add bot/src/skills/feature-requests.md
git commit -m "feat: add feature request handling skill for structured GitHub issues"
```

---

### Task 3: Commit factory infrastructure

The factory directory structure, templates, and dark-factory skill were created during brainstorming. Commit them.

**Files:**
- Commit: `factory/templates/event.json`
- Commit: `factory/runs/.gitkeep`
- Commit: `.claude/skills/dark-factory/SKILL.md`
- Commit: `docs/plans/2026-03-07-dark-factory-design.md`
- Commit: `docs/plans/2026-03-07-dark-factory-implementation.md`

**Step 1: Review all files**

Run: `git status`
Verify all the above files show as untracked

**Step 2: Commit**

```bash
git add factory/templates/event.json factory/runs/.gitkeep .claude/skills/dark-factory/SKILL.md docs/plans/2026-03-07-dark-factory-design.md docs/plans/2026-03-07-dark-factory-implementation.md
git commit -m "feat: dark factory pipeline infrastructure

Add factory directory structure, orchestrator skill, design doc,
and implementation plan for the conversation-driven automation pipeline."
```

---

### Task 4: Run full test suite

**Step 1: Run all tests**

Run: `cd bot && npx vitest run`
Expected: All tests pass

**Step 2: Run lint and format check**

Run: `cd bot && npm run check`
Expected: No errors

---

## Summary

| Task | What | Risk |
|------|------|------|
| 1 | Add `claude-work` default label | Minimal — one-line change, existing tests cover error paths |
| 2 | Feature request bot skill | None — new file, auto-loaded by existing code |
| 3 | Commit factory infrastructure | None — new files only |
| 4 | Full test suite verification | None — read-only |
