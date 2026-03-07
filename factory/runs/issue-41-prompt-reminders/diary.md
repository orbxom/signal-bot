# Diary — issue-41-prompt-reminders

- **2026-03-07 13:15** — Initialized. Mode: full. Issue #41: One-off reminders: add prompt mode (spawn session like recurring).
- **2026-03-07 13:16** — Research complete. Key findings: v6 migration for `mode` column, branch in `processReminder()`, reuse `RecurringReminderExecutor`, 8 files to modify.
- **2026-03-07** — Resumed from plan stage (Step 2: Plan Drafting). Previous session ended after research.
- **2026-03-07** — Plan drafted. 6 tasks: types, migration, store, scheduler, MCP tool, final validation. Approach: reuse RecurringReminderExecutor, branch in processReminder().
- **2026-03-07** — Devil's advocate: 14 concerns raised. Critical: Reminder/RecurringReminder type incompatibility, wrong constructor signature, missing timezone. Medium: getDueByGroup arity, makeReminder helpers, list_reminders display, no integration test, scheduler blocking risk.
- **2026-03-07** — Plan revised. Addressed: PromptExecution interface, correct constructor (no change needed), timezone fallback, getDueByGroup arity, makeReminder helpers, list_reminders display, Storage facade, tool description. Dismissed: mapReminderRow (spread handles it), integration test (deferred to Stage 6), blocking (acceptable for v1), recordAttempt (accepted), YAGNI (justified), v6 collision (checked).
- **2026-03-07** — Human approved plan. Moving to BUILD.
- **2026-03-07** — Worktree created at .worktrees/issue-41-prompt-reminders, branch feature/issue-41-prompt-reminders. 742 tests passing baseline. Dispatching implementation subagents.
