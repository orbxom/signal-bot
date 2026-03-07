# Research: Issue #2 — Support Image Attachments in Messages

## Executive Summary

The codebase is ~60% ready. Infrastructure for receiving, storing, and formatting image attachment metadata already exists (types, DB schema, message handler flow, context builder skeleton). The main gap is **actually making the image files accessible to Claude so it can see them**.

## Key Findings

### What Already Works
- `SignalAttachment` type with `id`, `contentType`, `size`, `filename`
- `signalClient.extractMessageData()` extracts attachments from Signal messages
- Messages with only attachments (no text) are accepted
- DB stores/retrieves attachment metadata as JSON in `attachments` column
- `messageHandler.ts` passes attachments through to LLM processing
- `contextBuilder.ts` has `formatImageAttachment()` producing `[Image attached: <path>]`
- System prompt includes `IMAGE_INSTRUCTIONS` telling Claude to use Read tool on images
- `send_image` MCP tool already handles sending images (base64, data URI pattern)
- Voice attachment flow provides template pattern for images

### What's Missing
1. **Attachment file download**: signal-cli provides metadata but files need to be on disk for Claude's Read tool
2. **Verification that signal-cli saves files**: Need to confirm signal-cli stores attachments at the configured `attachmentsDir` path
3. **Mock server support**: No way to test image attachments locally
4. **End-to-end testing**: No tests exist for attachment handling

### Claude CLI & Multimodal
- `claude -p` is text-only for the prompt argument
- However, Claude CLI's built-in **Read tool can read image files** from disk (it's multimodal)
- The current approach of `[Image attached: <path>]` + instructing Claude to use Read **is the correct pattern**
- No need to change `ChatMessage` type or build base64 content blocks — Claude reads the file itself

### Signal-cli Attachment Handling
- signal-cli stores received attachments on disk automatically
- Default location: `~/.local/share/signal-cli/attachments/` (configurable)
- Files are stored by attachment ID (no extension)
- The bot's `attachmentsDir` config may need to point to signal-cli's attachment directory, or files need to be copied/symlinked

### Related Issues
- Issue #3: Appears to be a duplicate
- Issue #13: Broader vision (Playwright + images) — Issue #2 should complete first
- Issue #5: BOM radar images — would benefit from this work

### Risk Areas
| Area | Risk | Mitigation |
|------|------|------------|
| File path resolution | signal-cli attachment IDs may not map to expected paths | Verify signal-cli storage; may need path translation |
| Large images | High token cost for Claude vision | Add size validation before passing to Claude |
| Extensionless files | Claude Read tool may not detect image MIME from extensionless files | May need to copy/rename with extension, or test behavior |
| Mock testing | Can't test without mock attachment support | Enhance mock server |
