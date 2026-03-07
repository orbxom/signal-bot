# Implementation Plan — Issue #35: GitHub PR Tools

## Goal
Extend `bot/src/mcp/servers/github.ts` with 6 PR tools so Claude can manage GitHub PRs from Signal. Acceptance criteria: all tools work, tests pass, lint clean.

## Approach
- Add tools to existing github.ts server (same env vars, same `gh` CLI pattern)
- Use `gh api` for viewing individual PRs (avoids GraphQL errors)
- Use `gh pr` commands for actions (list, comment, review, merge, diff)
- TDD: write tests first, then implement

## File Changes

### Modified: `bot/src/mcp/servers/github.ts`
- Add 6 tool definitions to TOOLS array
- Add 6 handler functions to handlers object
- Import `optionalString` from validate.ts

### Modified: `bot/tests/githubMcpServer.test.ts`
- Update tool count assertion (1 → 7)
- Add validation tests for each new tool (missing required params)

## Tasks (ordered)

### Task 1: Tool definitions + tool count test
Add 6 inputSchema definitions to TOOLS array. Update test tool count from 1 to 7.

### Task 2: list_pull_requests (test + implement)
- `gh pr list --repo {repo} --state {state} --limit {limit} --json number,title,state,author,url,draft,createdAt,updatedAt`
- Params: `state` (optional, default "open"), `limit` (optional number, default 10)
- Use `optionalString` for state, inline check for limit
- Format output as readable text list
- Tests: missing GITHUB_REPO returns error

### Task 3: view_pull_request (test + implement)
- `gh api repos/{owner}/{repo}/pulls/{number}`
- Params: `number` (required) — use `requireNumber` (not requireString, since LLMs emit numbers)
- Parse JSON, format readable summary: title, body, state, author, labels, reviewers, +/-/files, merged, draft, branches, URL
- Tests: missing number returns error

### Task 4: get_pr_diff (test + implement)
- `gh pr diff {number} --repo {repo}`
- Params: `number` (required) — `requireNumber`
- Truncate if over ~50k chars with note about truncation
- Tests: missing number returns error

### Task 5: comment_on_pull_request (test + implement)
- `gh pr comment {number} --repo {repo} --body {body}`
- Params: `number` (required, `requireNumber`), `body` (required, `requireString`)
- Tests: missing number/body returns error

### Task 6: review_pull_request (test + implement)
- Map event to flag: APPROVE → --approve, REQUEST_CHANGES → --request-changes, COMMENT → --comment
- `gh pr review {number} --repo {repo} --{flag} --body {body}`
- Params: `number` (required), `event` (required, validate against allowed values), `body` (optional)
- Tests: missing number/event returns error, invalid event returns error

### Task 7: merge_pull_request (test + implement)
- `gh pr merge {number} --repo {repo} --{strategy}`
- Params: `number` (required), `strategy` (optional: "merge"|"squash"|"rebase", default "squash")
- No `--delete-branch` (irreversible default — omit)
- Tests: missing number returns error

## Key Design Decisions (from devil's advocate review)

| Concern | Resolution |
|---------|-----------|
| PR number type coercion | Use `requireNumber` instead of `requireString` for PR numbers |
| `--delete-branch` on merge | Removed — irreversible default, omit entirely |
| No authorization on merge | User chose "no guard rails" during brainstorming — accepted |
| 14 tasks too granular | Consolidated to 7 tasks (test+implement paired) |
| Diff truncation method | Use char count (50k) — simpler than token estimation for this use case |
| No `optionalNumber` helper | Inline check for limit param |
| APPROVE review YAGNI? | Keep — all 3 events form complete workflow |

## Test Strategy
- Spawn-based integration tests (existing pattern in `bot/tests/githubMcpServer.test.ts`)
- Tests validate error paths (missing params, missing env) which don't call `gh`
- Success paths verified via mock signal integration testing (Stage 6)
- Use `mcpTestHelpers.ts` helpers: `spawnMcpServer`, `initializeServer`, `sendAndReceive`

## Verification
1. `cd bot && npx vitest run` — all tests pass
2. `cd bot && npm run check` — lint + format clean
3. Mock signal test with "list open PRs" and "what's in PR #32?"

## Revisions
- Used `requireNumber` for PR numbers (devil's advocate: type coercion bug)
- Removed `--delete-branch` from merge (devil's advocate: irreversible default)
- Consolidated 14 tasks → 7 (devil's advocate: too granular)
- Kept all 6 tools including APPROVE (disagreed with YAGNI concern)
- Kept char-based truncation (simpler than token estimation for diffs)
