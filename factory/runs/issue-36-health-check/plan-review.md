# Plan Review: Health Check MCP Server (Issue #36)

## Devil's Advocate Critique

---

### 1. Process isolation renders uptime and memory misleading

- **Concern**: The research document correctly identifies that `process.uptime()` and `process.memoryUsage()` reflect the MCP server subprocess, not the main bot process. Each MCP tool invocation spawns a fresh subprocess (via `npx tsx`), so `process.uptime()` will always report a value of a few seconds at most -- the time since the subprocess was spawned for that particular tool call. Similarly, `process.memoryUsage()` will report the memory footprint of a short-lived TypeScript interpreter running a single health check function, not the bot's actual memory consumption. These values are actively misleading: a user or Claude seeing "uptime: 2.3s" and "heapUsed: 45MB" would draw incorrect conclusions about the bot's operational state. The plan acknowledges this in research but then proceeds to implement it anyway without any mitigation.
- **Severity**: High
- **Recommendation**: Either (a) remove uptime and memory from the response entirely since they cannot report meaningful values in this architecture, (b) pass `BOT_START_TIME` as an env var from the main bot process (as the research mentions but the plan ignores) so at least uptime is accurate, or (c) prominently label these fields in the response as "mcp_server_process_uptime" and "mcp_server_process_memory" so Claude and users understand what they are measuring. Option (a) is the simplest and most honest. The issue's acceptance criteria say "uptime" and "memory usage" -- so at minimum document the limitation in the tool description.

---

### 2. MCP registry status is in the acceptance criteria but absent from the implementation

- **Concern**: The issue's acceptance criteria explicitly state: "health_check tool returns structured JSON with uptime, db status, signal connectivity, and memory usage." The issue body also lists "MCP server registry status (number of registered servers/tools)" as a component. The research document discusses counting `ALL_SERVERS` and their tools. Yet the plan's implementation returns `{ status, uptime, database, signal, memory, timestamp }` with no registry/MCP field at all. The plan description mentions "MCP registry status" in the tool's description string but the actual response JSON never includes it.
- **Severity**: High
- **Recommendation**: Add an `mcp` or `registry` field to the response. Given process isolation, the health check server cannot verify that other MCP servers are actually running, but it can import `ALL_SERVERS` from the barrel and report `{ registeredServers: N, registeredTools: M }` as a static count. This is low-effort and partially satisfies the criterion. The tool description should not claim to report something the response does not contain.

---

### 3. The `listGroups` RPC call returns potentially large payloads unnecessarily

- **Concern**: `listGroups` returns the full list of groups including member lists, names, and metadata. For a connectivity check, we only care whether signal-cli responds at all. The plan fetches the full response body and discards it (only checks `response.ok`). If the bot is in many groups, this is wasted bandwidth and parsing. More importantly, `listGroups` requires the `account` parameter to be valid -- if the account is wrong, the health check will report "unreachable" when signal-cli is actually running fine.
- **Severity**: Medium
- **Recommendation**: Consider using a lighter RPC method if one exists. If `listGroups` is the lightest available (the research says it mirrors `waitForReady()`), then at least consume the JSON-RPC response body to distinguish between "signal-cli is down" (connection refused) and "signal-cli returned an RPC error" (account misconfigured). Currently both cases map to `status: 'unreachable'`, which loses diagnostic information. Parse the response JSON and differentiate: `{ status: 'error', error: 'RPC error: No such account' }` vs `{ status: 'unreachable', error: 'ECONNREFUSED' }`.

---

### 4. The 5-second timeout on signal-cli check could make the health check slow

- **Concern**: If signal-cli is unreachable (e.g., process crashed but port is not refused -- perhaps behind a proxy or docker network), the health check will block for 5 seconds before returning. Since MCP tool calls are synchronous from Claude's perspective, this means Claude waits 5 seconds every time it runs a health check when Signal is down. In a scenario where Claude is asked to check health repeatedly (e.g., troubleshooting), this adds up.
- **Severity**: Low
- **Recommendation**: Consider reducing the timeout to 2-3 seconds. A connectivity check to a local service should not need 5 seconds. If signal-cli responds, it typically does so in <100ms. The `waitForReady()` method in `signalClient.ts` uses 5s because it retries with backoff during startup; a health check has different semantics.

---

### 5. The overall status calculation (healthy/degraded/unhealthy) has an asymmetric severity model

- **Concern**: The `getOverallStatus` function treats DB failure as "unhealthy" but signal failure as merely "degraded." This is a reasonable heuristic, but the plan does not document or test the reasoning. What if both DB and signal are down? The code returns "unhealthy" (because `db.status !== 'ok'` is checked first), which is correct but accidentally so -- the logic does not explicitly handle the "both down" case. More importantly, will Claude actually use this tri-state status value in a meaningful way? Claude will read the full JSON and can determine severity itself. The overall status field adds a layer of interpretation that may not match what Claude or a user actually needs.
- **Severity**: Low
- **Recommendation**: This is acceptable as-is but could be simplified. Consider whether the `status` field adds real value over just returning the component statuses and letting the consumer decide. If you keep it, add a test for the "both down" scenario to make the behavior explicit rather than accidental.

---

### 6. Database connection opened in `onInit` stays open for the lifetime of the MCP subprocess

- **Concern**: The health check server opens a `DatabaseConnection` in `onInit()`. This runs all schema migrations (tables, indexes, the full `initTables()` + `runMigrations()` sequence in `db.ts`). For a health check, this is heavyweight -- we only need `SELECT 1`. If the database schema is corrupted but the file is readable, the `DatabaseConnection` constructor will throw during migration, causing `onInit` to silently swallow the error (`catch {}`) and set `conn = null`. The health check then reports `{ status: 'error', error: 'Database not initialized' }` which is less informative than the actual migration error.
- **Severity**: Medium
- **Recommendation**: Consider opening a raw `better-sqlite3` connection directly instead of going through `DatabaseConnection`. Something like `new Database(dbPath, { readonly: true })` would suffice for `SELECT 1` and avoids running migrations. This also avoids the edge case where a health check subprocess races with the main bot on schema migrations. If you keep `DatabaseConnection`, at least capture and surface the `onInit` error message instead of silently swallowing it.

---

### 7. No test for the "both DB and signal are down" scenario

- **Concern**: The test suite covers: happy path (DB ok, signal unreachable by default), signal explicitly unreachable, signal URL empty, and DB path invalid. But there is no test for the case where both DB and signal fail simultaneously. Given the `getOverallStatus` logic, this should return "unhealthy", but this is untested.
- **Severity**: Low
- **Recommendation**: Add a test with an invalid DB path and an unreachable signal URL to confirm the overall status is "unhealthy" and both component errors are surfaced. This is a one-liner addition.

---

### 8. Test file location does not match issue's acceptance criteria

- **Concern**: The issue says "Add tests in `bot/src/mcp/servers/__tests__/healthCheck.test.ts`". The plan puts them in `bot/tests/healthCheckMcpServer.test.ts`. While the plan's location is consistent with where other MCP server tests live (e.g., `bot/tests/darkFactoryMcpServer.test.ts`, `bot/tests/reminderMcpServer.test.ts`), it explicitly contradicts the issue. This is a minor discrepancy but worth noting.
- **Severity**: Low
- **Recommendation**: Follow the existing test convention (which the plan does), but note the deviation from the issue description. The existing convention is the better choice since there is no `__tests__` directory pattern in this codebase.

---

### 9. The health check tool has no input parameters -- no way to check specific subsystems

- **Concern**: The tool always checks everything: DB, signal, memory, uptime. There is no way to ask "just check the database" or "just check signal." For now this is fine since there are only two real checks, but if more subsystems are added later (e.g., weather API, GitHub API), every health check invocation will hit all of them, making it slower and noisier.
- **Severity**: Low
- **Recommendation**: This is fine for now (YAGNI). If subsystem-specific checks are needed later, an optional `subsystem` parameter can be added. No action needed.

---

### 10. No rate limiting or caching on health check results

- **Concern**: If Claude or a user repeatedly calls `health_check` in quick succession (e.g., "check health every 10 seconds"), each call spawns a new MCP subprocess, opens a DB connection, and makes an HTTP request to signal-cli. The subprocess lifecycle means there is no natural place to cache results. However, given that each call is a fresh process, the overhead is the subprocess spawn itself (~500ms for `npx tsx`), not accumulated state.
- **Severity**: Low
- **Recommendation**: Not a real concern in practice. The MCP subprocess architecture naturally limits abuse -- spawning is slow enough to be self-throttling. No action needed unless this becomes a measured problem.

---

### 11. The `envMapping` maps `SIGNAL_ACCOUNT` to `'botPhoneNumber'` but the plan reads it from `process.env.SIGNAL_ACCOUNT` directly

- **Concern**: The `envMapping` declaration maps `SIGNAL_ACCOUNT: 'botPhoneNumber'`. This tells the registry to populate `SIGNAL_ACCOUNT` from `context.botPhoneNumber` when spawning the subprocess. This is correct for the registry wiring. However, in `onInit()`, the code reads `process.env.SIGNAL_ACCOUNT`, which works because the registry sets the env var. The naming is consistent with other servers (e.g., darkFactory does the same thing). No actual bug here, just verifying the chain is correct.
- **Severity**: Low (not actually a problem)
- **Recommendation**: No change needed. The env var flow is: `context.botPhoneNumber` -> registry sets `SIGNAL_ACCOUNT` env var -> `onInit` reads `process.env.SIGNAL_ACCOUNT`. This matches the darkFactory pattern exactly.

---

### 12. The plan does not use `catchErrors()` wrapper in the handler

- **Concern**: Other MCP servers consistently use the `catchErrors()` helper from `result.ts` to wrap handler logic, ensuring unexpected exceptions are caught and returned as MCP error responses. The health check handler does its own try/catch in `checkDatabase()` and `checkSignal()`, but the top-level `health_check()` handler has no catch-all. If `JSON.stringify()` throws (unlikely but possible with circular references), or if `process.uptime()` or `process.memoryUsage()` somehow throws, the handler will propagate an unhandled exception.
- **Severity**: Low
- **Recommendation**: Wrap the handler body in `catchErrors()` for consistency with the rest of the codebase, even though the risk is minimal.

---

### 13. The `onInit` error handling swallows the database error silently

- **Concern**: In `onInit()`, if `new DatabaseConnection(dbPath)` throws, the catch block does `console.error('Health check: failed to open database')` but does not capture the actual error message. The user or developer looking at stderr sees "failed to open database" but not why (permissions? corrupt file? disk full?). This makes debugging harder.
- **Severity**: Medium
- **Recommendation**: Log the actual error: `catch (err) { console.error('Health check: failed to open database:', err); }`. This is a one-line fix.

---

## Summary

| Severity | Count | Key Items |
|----------|-------|-----------|
| High     | 2     | #1 (misleading uptime/memory), #2 (missing MCP registry status) |
| Medium   | 3     | #3 (listGroups response not parsed), #6 (heavyweight DB init), #13 (swallowed error) |
| Low      | 8     | #4, #5, #7, #8, #9, #10, #11, #12 |

**Blocking issues**: #1 and #2 should be addressed before implementation. The health check should not report values that are actively misleading (process uptime of a short-lived subprocess), and it should include MCP registry status since both the issue description and the tool's own description claim to provide it.

**Recommended before implementation**: #6 (use raw `better-sqlite3` or read-only mode instead of full `DatabaseConnection` with migrations) and #13 (surface the actual DB error in logs).

**Nice to have**: #3 (parse signal-cli response for better diagnostics), #7 (test both-down scenario), #12 (use `catchErrors()` wrapper).
