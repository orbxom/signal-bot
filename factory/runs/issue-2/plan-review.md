# Plan Review: Image Attachment Support

**Reviewer role:** Devil's Advocate
**Date:** 2026-03-07

---

## 1. MCP Image Content Blocks Are Not Supported by the Type System or Runtime

**Rating: CRITICAL**

The plan's entire approach hinges on returning `{ type: 'image', data: '...', mimeType: '...' }` content blocks from MCP tool results. This has two distinct problems:

**Problem A: `ToolResult` type is text-only.**
The current `ToolResult` type in `bot/src/mcp/types.ts` (line 3-6) is:
```typescript
export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};
```
The plan acknowledges this and proposes updating it (Task 5, Step 4). However, the `ToolHandler` type signature returns `ToolResult | Promise<ToolResult>`. The plan's `ImageToolResult` local type in `images.ts` is a type-level escape hatch that does NOT actually change the `ToolHandler` signature in `types.ts`. Every existing handler and the `catchErrors`/`ok`/`error` helpers all use `ToolResult`. Changing `ToolResult` to include image blocks is fine, but the plan needs to verify that no existing code filters or validates content block types.

**Problem B: `runServer.ts` passes content through as-is -- but does Claude CLI consume it?**
I verified `runServer.ts` (lines 39-48): the `tools/call` handler calls `await handler(toolArgs)` and serializes `result` directly into JSON-RPC. It does NOT filter content block types. So the MCP server side will correctly serialize image blocks over the wire. Good.

**Problem C (the real critical issue): Does `claude -p` handle image content blocks from MCP tool results?**
The plan assumes Claude CLI will receive an MCP tool result containing `{ type: 'image', data: '...', mimeType: '...' }` and feed that image to Claude's vision model. This is the single most important assumption in the entire plan and it is NEVER validated. The research document (line 29) says "No need to change ChatMessage type or build base64 content blocks -- Claude reads the file itself." This directly contradicts the plan's approach of returning image blocks from MCP tools instead of file paths.

The research explicitly found that Claude CLI's **Read tool** can read image files from disk. It did NOT confirm that Claude CLI processes image content blocks from MCP tool results. These are different capabilities. The MCP protocol spec supports image content blocks, but Claude CLI's implementation may or may not pass them to the model.

**Recommendation:** Before writing any code, test this assumption. Create a minimal MCP server that returns an image content block, wire it up to `claude -p`, and verify Claude can "see" the image. If this doesn't work, the entire approach collapses and the simpler file-path-based approach (which the research already validated) should be used instead.

---

## 2. Base64 in SQLite TEXT Columns Is Wasteful

**Rating: IMPORTANT**

A 5MB image becomes ~6.7MB of base64 text. SQLite can handle this, but it has real costs:

- **DB bloat**: A few dozen images and the DB grows by hundreds of MB. This is a family chat bot with a single SQLite file -- the DB currently stores text messages and will be tiny. Images will dominate storage by orders of magnitude.
- **Memory pressure**: `SELECT * FROM attachment_data WHERE id = ?` loads the entire base64 blob into Node.js memory as a string. For a 10MB image, that's ~13MB of base64 string in memory.
- **No streaming**: better-sqlite3 doesn't support streaming BLOBs, but at least with BLOB storage you avoid the 33% base64 overhead.

**Alternatives to consider:**
1. **BLOB column instead of TEXT**: Store raw binary. Eliminates the 33% inflation. The MCP server can base64-encode on retrieval (which it must do anyway for the MCP response). The `save` path reads the file as a Buffer and stores it directly; the `get` path calls `buffer.toString('base64')`.
2. **Keep files on disk, store metadata in DB**: The simplest option. Signal-cli already stores the files. Just store the path/ID mapping in the DB and read from disk when needed. This avoids duplicating all image data.

**Recommendation:** Use BLOB storage at minimum. Better yet, consider option 2 -- keep files on disk. The DB stores metadata + file path, and the MCP server reads from disk on demand. This is dramatically simpler and avoids DB bloat entirely.

---

## 3. YAGNI: `listByGroup` and `getMetadata` Are Unused

**Rating: MINOR**

The plan defines three query methods:
- `get(id)` -- used by the MCP `view_image` tool. Needed.
- `getMetadata(id)` -- returns everything except `data`. Never called anywhere in the plan.
- `listByGroup(groupId)` -- returns metadata for all attachments in a group. Never called anywhere in the plan.

These add code, tests, and prepared statements that serve no current purpose. The plan includes tests for them (Task 1) and even delegates `getMetadata` through the Storage facade (Task 2), but no feature uses them.

**Recommendation:** Remove `getMetadata` and `listByGroup`. Add them later if a use case appears. The prepared statements and tests are trivial to add when needed.

---

## 4. Race Condition: File Read During Signal-cli Write

**Rating: MINOR**

When signal-cli receives an attachment, it writes the file to disk. The bot polls for messages via JSON-RPC. In theory, the file could still be writing when the bot tries to read it. In practice, signal-cli likely finishes the download before emitting the message via JSON-RPC (the message includes the attachment metadata, which means signal-cli has already processed it). The plan's `readAttachmentFile` catches errors and returns null, which is the right fallback.

However, there is a subtler issue: signal-cli may deliver the message metadata before the file is fully flushed to disk on some filesystems. The plan does not add any retry logic.

**Recommendation:** Acceptable risk. The null fallback is sufficient. If this becomes a real problem, add a single retry with a short delay. Not worth over-engineering now.

---

## 5. No Attachment Cleanup Strategy

**Rating: IMPORTANT**

The `messageStore` has `trimMessages` to keep the DB from growing unbounded. The plan adds no equivalent for attachments. Over time, the `attachment_data` table will grow without bound. Since each row can be megabytes (see concern #2), this is a more urgent problem than unbounded text messages.

**Recommendation:** Add a `trimAttachments` method that deletes attachments older than N days (or keeps only the most recent N per group). Wire it into the same periodic cleanup that calls `trimMessages`. Alternatively, if files are kept on disk (see concern #2), this becomes a filesystem cleanup problem instead.

---

## 6. The Simpler Alternative: File Paths Already Work

**Rating: IMPORTANT**

The research document explicitly states (line 29): "Claude CLI's built-in Read tool can read image files from disk (it's multimodal). The current approach of `[Image attached: <path>]` + instructing Claude to use Read **is the correct pattern**."

The current `contextBuilder.ts` already produces `[Image attached: /data/signal-attachments/abc]` and `IMAGE_INSTRUCTIONS` tells Claude to use the Read tool. If signal-cli stores attachment files at that path, the existing system already works for image viewing without ANY code changes beyond:

1. Ensuring `attachmentsDir` in config points to signal-cli's attachment directory
2. Verifying Claude CLI's Read tool handles extensionless files correctly

The plan replaces this working approach with a complex pipeline: read file from disk, base64-encode it, store in SQLite, expose via new MCP server, have Claude call new tool, return image content block. This is 5 steps replacing 1 step (Claude reads the file directly).

**What problem does the DB approach solve?**
- Signal-cli might delete attachments after delivery? (Unclear -- research doesn't address this.)
- Centralized storage for multi-instance deployments? (This is a single-instance family chat bot.)
- Attachment persistence after signal-cli data cleanup? (Plausible but speculative.)

**Recommendation:** The plan should explicitly justify why the DB approach is necessary. If signal-cli retains attachment files (which is the default behavior), the existing file-path approach is dramatically simpler and already works. The DB approach should only be pursued if there's a concrete reason files won't persist, or if the Critical issue (#1) about MCP image blocks is confirmed to work AND the file-path approach is confirmed to NOT work.

---

## 7. Migration Safety

**Rating: NON-ISSUE**

Migration v4 adds a new table and index. This is purely additive and safe. No concerns.

---

## 8. Test Design Gaps

**Rating: MINOR**

The tests are reasonable but have gaps:

- **No test for large images**: What happens when someone sends a 10MB photo? The plan has no size limits on ingestion. Should there be a max attachment size?
- **No test for non-image MIME types that start with "image/"**: Edge case, but `image/svg+xml` is technically an image -- should SVGs be ingested? They can contain scripts.
- **Integration test is shallow**: Task 7's "integration test" just calls store methods and the context builder in sequence. It doesn't test the actual MCP tool handler or the message handler ingestion path. It's really three unit tests in a trenchcoat.
- **MCP server test has unclear DB injection**: The test in Task 5 calls `imagesServer.handlers.view_image` directly but the handler uses module-level `store` variable initialized by `onInit()`. The test needs to either call `onInit()` with a mocked env pointing to the in-memory DB, or refactor the store injection. The plan acknowledges this uncertainty ("see implementation for how") but doesn't resolve it.

**Recommendation:** Add a size limit (e.g., 10MB) to ingestion with a test. Resolve the MCP server test DB injection before implementation, not during.

---

## 9. The `ToolHandler` Return Type Mismatch

**Rating: IMPORTANT**

The plan defines `ImageToolResult` as a local type in `images.ts` and has the handler return it. But `McpServerDefinition.handlers` is typed as `Record<string, ToolHandler>`, and `ToolHandler` returns `ToolResult | Promise<ToolResult>`. The widened `ImageToolResult` type won't satisfy `ToolHandler` without updating the base `ToolResult` type.

The plan says to update `ToolResult` in Step 4 of Task 5, but it also defines `ImageToolResult` separately in Step 3. This is contradictory. If `ToolResult` is updated to include image blocks, there's no need for `ImageToolResult`. If it's not updated, the handler won't type-check.

**Recommendation:** Update `ToolResult` to support image content blocks (as the plan suggests in Step 4), remove the local `ImageToolResult` type entirely, and update `ok()` / `error()` helpers if needed. Do this FIRST (before writing the server), not as an afterthought.

---

## Summary

| # | Concern | Rating |
|---|---------|--------|
| 1 | MCP image content blocks may not work with Claude CLI | CRITICAL |
| 2 | Base64 in TEXT columns is wasteful; use BLOB or files | IMPORTANT |
| 3 | `listByGroup` and `getMetadata` are unused (YAGNI) | MINOR |
| 4 | Race condition on file read | MINOR |
| 5 | No attachment cleanup/trimming strategy | IMPORTANT |
| 6 | File-path approach may already work without any new code | IMPORTANT |
| 7 | Migration safety | NON-ISSUE |
| 8 | Test design gaps (size limits, DB injection) | MINOR |
| 9 | `ToolHandler` return type mismatch with `ImageToolResult` | IMPORTANT |

**Bottom line:** The plan cannot proceed without resolving concern #1. If Claude CLI does not support image content blocks from MCP tool results, the entire DB-backed MCP server approach is pointless. The plan should first validate this assumption with a spike, and seriously consider whether the existing file-path + Read tool approach (which the research already confirmed works) is sufficient. If the DB approach is pursued, use BLOB storage instead of base64 TEXT, add cleanup/trimming, and drop the unused query methods.
