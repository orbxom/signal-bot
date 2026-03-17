# Research — issue-26-attachment-cleanup

## Key Findings

### Infrastructure Already Exists
- `AttachmentStore.trimOlderThan(cutoffTimestamp: number): void` — deletes from `attachment_data WHERE timestamp < ?` (attachmentStore.ts:54-61)
- `Storage.trimAttachments(cutoffTimestamp: number): void` — facade delegating to above (storage.ts:186-188)
- Neither is ever called anywhere in the codebase

### Current Cleanup Pattern
- `trimMessages(groupId, keepCount)` called at messageHandler.ts:403 after every LLM response
- Count-based: keeps N most recent messages per group (default 1000, configurable via `MESSAGE_RETENTION_COUNT`)
- No attachment cleanup triggered

### Attachment Cleanup Design
- `trimOlderThan()` is time-based (cutoff timestamp), not count-based like messages
- `attachment_data` table has index on `(groupId, timestamp DESC)` — efficient for range deletes
- BLOBs stored inline in SQLite; DELETE removes data but doesn't shrink file (VACUUM needed for that, but out of scope)

### Test Patterns
- AttachmentStore already has trim test (attachmentStore.test.ts:75-103): save old + new, trim, verify old gone
- MessageHandler tests verify `trimMessages()` called with correct args (messageHandler.test.ts:194-204)
- Test helpers: `createTestDb()` and `createTestStorage()` in tests/helpers/testDb.ts

### No Conflicts
- No active factory runs touch attachment cleanup, storage.ts, or messageHandler cleanup logic
- Attachment infrastructure introduced in PR #25 (commit cd36379) but cleanup hook never connected

## Recommended Approach
1. Add `ATTACHMENT_RETENTION_DAYS` config (default 30)
2. Call `storage.trimAttachments(cutoffTimestamp)` alongside `trimMessages()` in messageHandler.ts:403
3. Test: verify trimAttachments called with correct cutoff after LLM response
4. VACUUM is out of scope — just making cleanup happen at all is the fix
