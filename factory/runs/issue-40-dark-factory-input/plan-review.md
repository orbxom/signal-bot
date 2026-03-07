# Plan Review: send_dark_factory_input (Issue #40)

## Overall Assessment

The plan is well-structured and the implementation is sensible for the mechanical "send keystrokes" part. However, it delivers roughly half of what the issue asks for. The acceptance criteria explicitly require auto-handling safe prompts and escalating non-obvious ones. The plan punts on both, which means the issue cannot be closed by this implementation alone. That needs to be an explicit decision, not an implicit omission.

---

## 1. The Plan Does Not Satisfy Acceptance Criteria 3 and 4

This is the most significant problem.

**Acceptance Criteria 3:** "Safe prompts (tool-use confirmations, continue/proceed) are auto-handled without user intervention"
**Acceptance Criteria 4:** "Non-obvious prompts (option selection, open-ended questions) are surfaced to the user for decision"

The plan explicitly says: "Prompt classification (safe vs needs-escalation) is intentionally NOT built into the tool. The LLM (Claude) is better suited to determine whether a prompt is safe to auto-handle or needs user escalation."

This hand-wave has two problems:

**a) There is no mechanism for the LLM to do this autonomously.** The `send_dark_factory_input` tool is passive -- it only fires when someone calls it. There is nothing in the plan that monitors dark factory sessions for prompts and triggers the classification flow. Who calls `send_dark_factory_input` when a dark factory session hits a prompt at 3am? The issue says auto-handle. The plan gives you a wrench and says "someone will use it."

**b) Even if the LLM did classify prompts, the "escalate to user" flow is undefined.** The issue says "report the question back to the user via Signal and wait for their answer before sending input." How does that work? The bot receives a Signal message, invokes Claude, Claude uses `read_dark_factory` or `send_dark_factory_input`, sees a non-obvious prompt, sends a Signal message to the user... and then what? The Claude invocation is finished. There is no "wait for their answer" mechanism. The user replies, which triggers a new bot invocation with no memory of the pending dark factory prompt. This is an architectural gap, not something you can hand-wave to the LLM.

**Recommendation:** Either (a) explicitly descope criteria 3 and 4 from this PR and create follow-up issues for the monitoring/auto-response loop and the escalation flow, or (b) design those mechanisms as part of this plan. Descoping is the honest choice -- the tool itself is useful without auto-handling, but the issue should not be marked as done.

---

## 2. Silent Failure on Detached Sessions (Known Bug)

The research documents this thoroughly -- zellij 0.43.1 has a known bug where `write-chars` silently succeeds on detached sessions (the kitty window was closed). The plan says "our sessions are attached so it's fine," but the tool should be defensive.

The current implementation:
1. `dump-screen` to file -- this will fail if detached, so we detect the session is unreachable. Good.
2. `write-chars` -- if the session becomes detached between step 1 and step 2 (race), this silently succeeds. The user thinks input was sent but nothing happened.

More importantly: the `dump-screen` call creates a temp file and reads it. If `dump-screen` succeeds (session was attached a moment ago) but then the kitty window is closed before `write-chars` runs, the tool returns "Input sent" when it was actually dropped on the floor.

**Recommendation:** After sending input, do a brief sleep (100-200ms) then `dump-screen` again to verify the terminal state changed, or at minimum document this as a known limitation. Alternatively, use `zellij list-sessions --no-formatting` to check session state before input (the research already documents how to check for EXITED state).

---

## 3. The "Last 50 Lines" Heuristic Is Arbitrary and Potentially Wrong

The plan reads the last 50 lines of `dump-screen` output. But `dump-screen` (without `--full`) captures only the visible viewport, which is typically 30-50 lines depending on terminal size. So `.slice(-50)` on a viewport dump that is already ~40 lines effectively returns the whole thing (with trailing blank lines).

This is confusing in two ways:
- The description says "last 50 lines" but what you are really returning is "the visible terminal viewport, trimmed."
- If someone uses `--full` in the future (for scrollback), 50 lines would be insufficient context.
- The lines include blank lines from the viewport. `trimEnd()` handles trailing whitespace, but what about the dozens of blank lines that appear in the middle of a terminal dump when the output hasn't filled the screen?

**Recommendation:** Filter out empty/whitespace-only lines before slicing, or just return the entire viewport (it is already bounded by terminal size). Be explicit in the tool description that this is the visible viewport, not scrollback.

---

## 4. Three Sequential `execFileSync` Calls Per Invocation

Each tool invocation makes up to three synchronous blocking calls:
1. `execFileSync('zellij', [..., 'dump-screen', ...])` -- 5s timeout
2. `execFileSync('zellij', [..., 'write-chars', ...])` -- 5s timeout
3. `execFileSync('zellij', [..., 'write', '13'])` -- 5s timeout

Worst case: 15 seconds of blocking. This is on the MCP server's event loop. If the MCP server handles multiple tool calls, this blocks everything.

In practice the calls should be sub-100ms each, but the 5-second timeouts mean a flaky zellij could stall the server for a long time.

**Recommendation:** This is acceptable for now since the dark factory MCP server is unlikely to receive concurrent requests. But if it ever does, consider switching to `execFile` (async) with Promise wrappers. Worth a comment noting the synchronous nature is intentional.

---

## 5. Temp File Cleanup Race Condition

```typescript
const dumpFile = path.join(os.tmpdir(), `dump-${safeName}-${Date.now()}.txt`);
```

`Date.now()` provides millisecond resolution. If `send_dark_factory_input` is called twice in the same millisecond for the same session (unlikely but possible with concurrent callers), they write to the same temp file. One will read the other's dump.

**Recommendation:** Use `fs.mkdtempSync` or add `Math.random()` / `crypto.randomUUID()` to the filename. This is a minor concern but trivially fixable.

---

## 6. `press_enter` Default of `true` Is an Implicit Landmine

The plan defaults `press_enter` to `true` via `args.press_enter !== false`. This means:
- If the LLM passes `press_enter: undefined`, it sends Enter.
- If the LLM passes `press_enter: true`, it sends Enter.
- Only `press_enter: false` suppresses Enter.

This is correct behavior for "answer a prompt" use cases. But consider: what if the LLM needs to send Ctrl+C (byte 3) to interrupt a stuck process? The current design has no mechanism for that -- `write-chars` sends printable text, and the only special key is Enter. The research documents `write 3` for Ctrl+C and `write 27` for Escape, but the tool cannot send them.

**Recommendation:** Either add a `special_key` parameter (one of: "enter", "ctrl-c", "escape", "none") or document why Ctrl+C is intentionally excluded. If it is excluded, how do you recover from a stuck dark factory session?

---

## 7. Input Validation Gap: Empty String After Whitespace Trim

`requireString` rejects empty strings, so `input: ""` returns an error. Good. But what about `input: " "` (whitespace only)? `requireString` accepts it (it checks `val === ''`), and `write-chars " "` sends a space to the terminal. Is that ever intentional? Probably not -- it would just press Space in the terminal, which could accidentally confirm something.

**Recommendation:** Consider whether whitespace-only input should be rejected, or at least documented as intentional behavior.

---

## 8. No Input Sanitization Beyond Path Traversal

`execFileSync` prevents shell injection (good -- no shell interpolation). `path.basename()` prevents path traversal on session names (good). But `input.value` is passed directly to `write-chars`. Can `write-chars` interpret any special sequences?

From the zellij docs, `write-chars` sends literal characters. So `write-chars "$(rm -rf /)"` sends the literal string `$(rm -rf /)` to the terminal. But the terminal is running `bash` (or Claude Code), which could interpret that string if it lands in a bash prompt.

In practice, the dark factory terminal is running Claude Code's interactive TUI, not a raw bash prompt, so typed text goes to Claude's input field. But if Claude Code exits or crashes, the terminal could drop to a bash shell, and then `write-chars` delivers text directly to bash.

**Recommendation:** This is an inherent risk of keystroke injection. The mitigation is that `DARK_FACTORY_ENABLED` gates the tool, and only the bot's LLM calls it. Worth a comment acknowledging the risk. No real fix is possible without sandboxing the terminal.

---

## 9. Test Coverage Gaps

The plan tests:
- Disabled gate
- Missing session_name
- Missing input
- Nonexistent session metadata
- Metadata exists but zellij unreachable

What is NOT tested:
- **`press_enter` parameter behavior** -- no test for `press_enter: false` vs default `true`.
- **Successful input sending** -- the plan defers this to "Stage 6 integration tests." That means the happy path is entirely untested. Not even a mocked `execFileSync` test.
- **The screen output parsing** -- no test that verifies the "last 50 lines" logic works correctly (blank line handling, trimming, etc.).
- **Error from `write-chars` after successful `dump-screen`** -- the catch block around write-chars returns an error, but no test exercises this path.

**Recommendation:** Add at least one test with a mocked `execFileSync` (via `vi.mock('node:child_process', ...)`) that verifies the happy path: dump-screen returns content, write-chars succeeds, the response includes terminal context and confirmation. This is the core behavior of the tool and it has zero test coverage.

---

## 10. YAGNI Check

- **Tool definition, handler, validation** -- all necessary. No YAGNI violations.
- **`press_enter` parameter** -- useful and lightweight. Fine.
- **Returning screen content in the response** -- required by acceptance criteria 2. Fine.
- **Four-task breakdown for what amounts to ~60 lines of new code** -- overly granular. Task 1 (skeleton) and Task 3 (implementation) could be one task. The skeleton adds no value since it will be replaced in the same PR. Similarly, Task 2 (validation tests) and Task 4 (integration test) could be one task. This is process overhead, not a code concern.

---

## 11. Missing Consideration: `read_dark_factory` vs `dump-screen` Overlap

The existing `read_dark_factory` reads Claude's JSONL conversation files. The new tool reads the terminal screen via `dump-screen`. These serve different purposes but have overlapping use cases -- if you want to know "what is happening in the dark factory," you might use either.

The plan does not discuss whether `read_dark_factory` should also support `dump-screen` mode (e.g., a `mode: 'screen'` parameter), or whether it should remain JSONL-only. If the answer is "they are separate tools," that is fine, but worth acknowledging to prevent future confusion.

---

## 12. The Plan Says Nothing About How This Tool Gets Called

The tool exists. But who calls it? Looking at the bot architecture:
- A Signal user says "claude: check on the dark factory"
- The bot's LLM gets invoked, uses `read_dark_factory` to see progress
- It might notice a prompt. Then it uses `send_dark_factory_input` to respond.

But that requires the user to ask. The issue's acceptance criteria 3 says "auto-handled without user intervention." That implies some kind of polling/monitoring loop that detects prompts and responds to them automatically.

The existing `reminderScheduler.ts` has a recurring check pattern. Should there be a similar "dark factory monitor" that periodically reads session screens and auto-responds to safe prompts? The plan is completely silent on this.

**Recommendation:** Explicitly state whether auto-handling is in scope or out of scope for this issue. If out of scope, create a follow-up issue.

---

## Summary of Recommendations

| # | Severity | Issue | Recommendation |
|---|----------|-------|----------------|
| 1 | **High** | Acceptance criteria 3 & 4 not addressed | Descope explicitly and create follow-up issues |
| 2 | Medium | Silent failure on detached sessions | Verify session state before sending, or document limitation |
| 3 | Low | "Last 50 lines" heuristic is misleading | Filter blank lines; document that it is the visible viewport |
| 4 | Low | Three blocking sync calls | Acceptable; add a comment noting intentional sync |
| 5 | Low | Temp file name collision | Use randomUUID in filename |
| 6 | Medium | No Ctrl+C / special key support | Add special_key parameter or document why excluded |
| 7 | Low | Whitespace-only input accepted | Decide if intentional; document either way |
| 8 | Low | Input reaches terminal as-is | Inherent risk; add comment |
| 9 | **High** | Happy path has zero test coverage | Mock execFileSync and test the core flow |
| 10 | Low | Four tasks for ~60 lines | Consolidate to 2 tasks |
| 11 | Low | Overlap with read_dark_factory | Acknowledge in plan notes |
| 12 | **High** | No auto-handling mechanism | Same as #1; needs explicit descoping or design |
