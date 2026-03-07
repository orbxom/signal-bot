# Devil's Advocate Review — Issue #35

## High Severity

### 1. PR number type coercion
`requireString` rejects numbers, but LLMs often emit `number: 42` not `number: "42"`. Use `requireNumber` and convert to string for CLI args.

### 2. No authorization for destructive operations
`merge_pull_request` and `review_pull_request --approve` are accessible to anyone in the group chat. User explicitly chose "no guard rails" during brainstorming — accepted risk.

## Medium Severity

### 3. `--delete-branch` hardcoded on merge
Irreversible default. Should be opt-in or omitted entirely.

### 4. 14 tasks too granular
Consolidate test/implement pairs into single tasks per tool.

### 5. Test strategy only covers error paths
No tests for output formatting, diff truncation, or review event mapping. Extract pure functions and unit test them.

## Low Severity

### 6. Diff truncation should use tokens not chars
Use `estimateTokens()` from result.ts instead of raw char count.

### 7. No `optionalNumber` helper
Use inline check for `limit` param rather than adding to validate.ts.

### 8. APPROVE review event is YAGNI?
Disagree — all 3 events form a complete review workflow. Keep all.
