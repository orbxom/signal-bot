# Attachment BLOB Cleanup Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Call `trimAttachments()` alongside `trimMessages()` so image BLOBs don't accumulate in SQLite forever.

**Architecture:** Add a configurable `ATTACHMENT_RETENTION_DAYS` (default 30) to config. In `messageHandler.ts`, call `storage.trimAttachments()` right after the existing `trimMessages()` call, using a timestamp cutoff derived from the retention days. TDD throughout.

**Tech Stack:** TypeScript, SQLite (better-sqlite3), vitest

---

### Task 1: Add attachment retention config

**Files:**
- Modify: `bot/src/config.ts` — add `ATTACHMENT_RETENTION_DAYS` env var
- Test: `bot/tests/config.test.ts` (if exists, otherwise skip dedicated test — config is trivial)

**Step 1: Read config.ts to understand the pattern**

Read `bot/src/config.ts` and note how `MESSAGE_RETENTION_COUNT` is loaded. The new config follows the same pattern.

**Step 2: Add `attachmentRetentionDays` to config**

In `bot/src/config.ts`:
1. Add `attachmentRetentionDays: number` to the `ConfigType` interface
2. Add to the return object in `Config.load()`:

```typescript
attachmentRetentionDays: parseInt(process.env.ATTACHMENT_RETENTION_DAYS || '30', 10) || 30,
```

The double `|| 30` ensures that if `parseInt` returns `NaN` (e.g. `ATTACHMENT_RETENTION_DAYS=banana`), it falls back to 30. This matches the existing pattern for other numeric config values.

**Step 3: Verify no syntax errors**

Run: `cd bot && npx tsc --noEmit`
Expected: No errors

**Step 4: Commit**

```bash
git add bot/src/config.ts
git commit -m "feat(config): add ATTACHMENT_RETENTION_DAYS setting (default 30)"
```

---

### Task 2: Wire trimAttachments into MessageHandler (TDD)

**Files:**
- Modify: `bot/src/messageHandler.ts` — add `trimAttachments()` call after `trimMessages()`
- Test: `bot/tests/messageHandler.test.ts` — add test verifying `trimAttachments()` is called

**Step 1: Read the existing test for trimMessages**

Read `bot/tests/messageHandler.test.ts` and find the test that verifies `trimMessages()` is called (around line 194-204). Note:
- How `mockStorage` is set up
- What assertion pattern is used (`toHaveBeenCalledWith`)
- Whether `mockStorage.trimAttachments` already exists as a mock (it should if the mock mirrors the Storage interface)

**Step 2: Write the failing test**

Add a test in the same describe block that tests `trimMessages`:

```typescript
it('should call trimAttachments with correct cutoff after LLM response', async () => {
  const mockNow = 1700000000000;
  vi.spyOn(Date, 'now').mockReturnValue(mockNow);

  // ... same setup as the trimMessages test to trigger processLlmRequest ...

  expect(mockStorage.trimAttachments).toHaveBeenCalledTimes(1);
  const expectedCutoff = mockNow - (30 * 24 * 60 * 60 * 1000);
  expect(mockStorage.trimAttachments).toHaveBeenCalledWith(expectedCutoff);

  vi.restoreAllMocks();
});
```

**Important:** Mock `Date.now()` for deterministic testing instead of using time-window tolerance. Check if the test file already has a `Date.now` mock pattern to reuse.

If `mockStorage` doesn't already have `trimAttachments` as a mock function, add it to the mock setup:
```typescript
trimAttachments: vi.fn(),
```

**Step 3: Run test to verify it fails**

Run: `cd bot && npx vitest run tests/messageHandler.test.ts`
Expected: FAIL — `trimAttachments` was not called (0 times instead of 1)

**Step 4: Implement the fix in messageHandler.ts**

In `bot/src/messageHandler.ts`, right after the `trimMessages()` call (line ~403), add:

```typescript
// Trim old attachments
const attachmentCutoff = Date.now() - (this.attachmentRetentionDays * 24 * 60 * 60 * 1000);
this.storage.trimAttachments(attachmentCutoff);
```

In the constructor, add the retention days parameter:
```typescript
this.attachmentRetentionDays = options?.attachmentRetentionDays || 30;
```

Add the property declaration:
```typescript
private readonly attachmentRetentionDays: number;
```

Update the `MessageHandlerOptions` type (or wherever the constructor options are typed) to include:
```typescript
attachmentRetentionDays?: number;
```

**Step 5: Run test to verify it passes**

Run: `cd bot && npx vitest run tests/messageHandler.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add bot/src/messageHandler.ts bot/tests/messageHandler.test.ts
git commit -m "fix: call trimAttachments alongside trimMessages after LLM response

Closes #26"
```

---

### Task 3: Wire config into index.ts

**Files:**
- Modify: `bot/src/index.ts` — pass `attachmentRetentionDays` from config to MessageHandler

**Step 1: Read index.ts to find where MessageHandler is constructed**

Read `bot/src/index.ts` and find where `new MessageHandler(...)` is called. Note the options object passed.

**Step 2: Add attachmentRetentionDays to the options**

```typescript
attachmentRetentionDays: config.attachmentRetentionDays,
```

Add this to the existing options object passed to `new MessageHandler()`.

**Step 3: Verify full test suite passes**

Run: `cd bot && npx vitest run`
Expected: All tests pass

**Step 4: Run lint and format check**

Run: `cd bot && npm run check`
Expected: No errors

**Step 5: Commit**

```bash
git add bot/src/index.ts
git commit -m "feat: wire attachment retention config into MessageHandler"
```

---

## Revisions

### After devil's advocate review:
- **Addressed (CRITICAL):** Added `ConfigType` interface update to Task 1 — must update both the interface and the return object
- **Addressed (CRITICAL):** Added `|| 30` fallback after `parseInt` to handle NaN from invalid env var values
- **Addressed (MINOR):** Changed test to mock `Date.now()` for deterministic assertions instead of time-window tolerance
- **Dismissed:** Global vs group-scoped trim asymmetry — age-based global cleanup is intentional; the existing `trimOlderThan` SQL has no groupId filter by design
- **Dismissed:** Quiet groups never cleaned — cleanup runs on any group's LLM response, frequent enough; adding periodic timer is over-engineering for a bug fix
- **Dismissed:** Dangling `attachment://` references — `view_image` MCP tool already handles null gracefully (returns error to LLM)
- **Dismissed:** YAGNI on env var — acceptance criteria explicitly says "configurable age-based cutoff"
