# Devil's Advocate Review — Disposition

## BLOCKER: Croner API mismatch
**DISMISSED.** Verified with croner 10.0.1: `nextRun(date)` accepts a Date argument, `nextRuns(n, date)` works too. Plan's API usage is correct.

## HIGH: Sequential blocking (issue #7)
**ACCEPTED.** Limit recurring processing to 1 per group per tick. Simple and safe.

## HIGH: No failure strategy (issue #11)
**ACCEPTED.** Add `consecutiveFailures` column. After 5 consecutive failures, auto-cancel and notify group. On success, reset to 0. On failure, advance `nextDueAt` to avoid retrying the same missed slot.

## MEDIUM: Missing MCP tests (issue #10)
**ACCEPTED.** Add integration tests for the 3 new tools using existing `spawnMcpServer`/`sendAndReceive` pattern.

## MEDIUM: In-flight timeout = spawn timeout (issue #6)
**ACCEPTED.** Increase `IN_FLIGHT_TIMEOUT_MS` to 7 minutes (2 min buffer over 5 min spawn timeout).

## MEDIUM: DST edge cases (issue #4)
**PARTIALLY ACCEPTED.** Add a basic DST test. Croner handles DST transitions internally — our wrapper just calls `nextRun()`. We trust croner's implementation.

## MEDIUM: Missing --agents config (issue #8)
**ACCEPTED.** Add `--agents` config to executor so recurring reminders can use the message-historian subagent.

## LOW: YAGNI paused status (issue #2)
**ACCEPTED.** Remove `paused` status. Ship with `active | cancelled` only.

## LOW: YAGNI describeCron (issue #3)
**DISMISSED.** It's 8 lines and provides valuable confirmation to users. Worth keeping.

## LOW: One-shot risk / try-catch wrapper (issue #5)
**ACCEPTED.** Wrap `processRecurringReminders` call in its own try/catch.

## LOW: DB concurrency (issue #12)
**DISMISSED.** Existing architecture already has this pattern. No action needed.

## LOW: Version pinning (issue #13)
**ACCEPTED.** Pin croner to `^10.0.0`.
