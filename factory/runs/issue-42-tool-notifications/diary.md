# Diary — issue-42-tool-notifications

**2026-03-07 23:25** — Initialized. Mode: full. Issue #42: MCP tool Signal notifications with per-group toggle.

**2026-03-07 23:30** — Research sprint: dispatched 3 parallel agents (codebase analyst, docs researcher, prior art reviewer).

**2026-03-07 23:35** — Research complete. Key findings: (1) darkFactory.ts already has inline sendSignalNotification() — extract into shared utility; (2) active_personas table is the model for per-group toggle; (3) 9 servers need SIGNAL_CLI_URL added to envMapping; (4) creating-mcp-tools skill needs new notification section; (5) read-only tools getting notifications may be noisy — needs design decision.

**2026-03-07 23:40** — Plan drafted. 5 tasks: store+migration, notification utility, settings MCP server, update 9 existing servers, update skill docs. Key design: `withNotification()` as drop-in `catchErrors()` replacement, `[tool]` prefix for messages, process-lifetime DB cache, fire-and-forget sends.

**2026-03-07 23:45** — Devil's advocate: 3 critical, 5 important, 7 minor concerns. Critical: withNotification changes catchErrors semantics, missing memories.ts server, inflexible success message API.

**2026-03-07 23:50** — Plan revised. Addressed: (1) withNotification now composes around catchErrors (no behavioral change); (2) added memories.ts; (3) success message supports callback; (4) only state-changing tools get notifications; (5) setting passed as env var from registry (no DB in notify.ts); (6) prefix changed to "Done/Failed"; (7) fixed settings server tests. Dismissed: boolean param (LLMs handle fine), fire-and-forget ordering (intentional), rate limiting (YAGNI).

**2026-03-07 23:55** — Human approved plan. Moving to BUILD.

**2026-03-08 00:00** — Worktree created at `.worktrees/issue-42-tool-notifications/` on branch `feature/issue-42-tool-notifications`. 742 tests passing. Dispatching Phase 1 agents (Tasks 1, 2, 6 in parallel).

**2026-03-08 00:05** — Phase 1 complete (Tasks 1, 2, 6). Task 1: store+migration, 5 new tests. Task 2: notify.ts, 13 new tests. Task 6: skill docs updated.

**2026-03-08 00:10** — Phase 2 complete (Tasks 3, 4). Task 3: registry passes TOOL_NOTIFICATIONS_ENABLED/SIGNAL_CLI_URL/SIGNAL_ACCOUNT to all servers, 7 new registry tests. Task 4: settings MCP server with toggle/status tools, 8 new tests. Total: 774 tests passing.

**2026-03-08 00:15** — Dispatching Phase 3: Task 5 (update 6 state-changing servers with withNotification).

**2026-03-08 00:20** — Task 5 complete. All 6 servers updated: reminders (4 handlers), dossiers (1), personas (4), github (4), memories (2), darkFactory (1 + refactored inline notification). darkFactory's inline sendSignalNotification() removed. 774 tests pass. Lint/format clean. BUILD complete.
