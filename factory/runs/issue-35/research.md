# Research — Issue #35: GitHub PR Tools

## Codebase Analysis

### Files to Modify
- `bot/src/mcp/servers/github.ts` (90 lines) — Extend with 6 new tools
- `bot/tests/githubMcpServer.test.ts` (128 lines) — Add tests for new tools, update tool count assertion

### Reusable Patterns
- `execFileAsync('gh', [...args])` with 30s timeout
- `requireString(args, 'name')` → check `.error` → use `.value`
- `catchErrors(async () => { ... }, 'prefix')` wrapper
- `ok(text)` / `error(text)` responses
- `optionalString(args, 'name', defaultValue)` for optional params

### Test Infrastructure
- `spawnMcpServer(env)` / `initializeServer()` / `sendAndReceive()` from `bot/tests/helpers/mcpTestHelpers.ts`
- Tests spawn actual server subprocess and communicate via JSON-RPC
- Need to update line 47: tool count assertion from 1 to 7

### Environment
- `GITHUB_REPO` already in envMapping
- `MCP_SENDER` already available
- No new env vars needed

## gh CLI Research

### Safe Commands (REST API, no GraphQL issues)
- `gh pr list --repo R --json fields` — works reliably
- `gh pr comment N --repo R --body B` — works
- `gh pr review N --repo R --approve/--request-changes/--comment` — works
- `gh pr merge N --repo R --squash/--merge/--rebase` — works
- `gh pr diff N --repo R` — works
- `gh api repos/owner/repo/pulls/N` — REST API, no GraphQL errors

### Unsafe Commands (GraphQL issues)
- `gh pr view` — fails with GraphQL errors for non-existent PRs
- Solution: use `gh api` for individual PR lookups

## No Conflicts
- No other open issues target github.ts
- Server already registered in ALL_SERVERS array
- No registry or index changes needed
