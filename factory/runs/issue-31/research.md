# Research: Issue #31 — Add "c " as a Short Mention Trigger

## Architecture Summary

The mention trigger system is cleanly separated:
- `config.ts:62-67` — Parses `MENTION_TRIGGERS` env var (comma-separated, trimmed, filtered)
- `mentionDetector.ts` — `isMentioned()` uses case-insensitive `startsWith()`, `extractQuery()` strips all triggers and normalizes whitespace
- `messageHandler.ts:90` — Calls `isMentioned()` before processing; `extractQuery()` at line 320

## Critical Finding: `.trim()` Strips Trailing Space

**This is the main technical challenge.** Config parsing does:
```typescript
.split(',').map(s => s.trim()).filter(s => s.length > 0)
```

If `MENTION_TRIGGERS=claude:,c `, after trim, `"c "` becomes `"c"`. Then `isMentioned("cat")` would return `true` because `"cat".startsWith("c")` is true. This would cause massive false positives.

**Options:**
1. Change config parsing to not trim (breaks existing behavior)
2. Use a different separator that preserves spaces
3. Handle "c " specially in the default config code, not via env var parsing
4. Add the trigger programmatically after parsing (hardcode it alongside env var triggers)

**Recommended:** Option 3 or 4 — keep env var parsing unchanged, but add "c " as a default trigger in the config code itself, bypassing the trim issue. Or better: fix the trim to only trim non-significant whitespace (but this is complex).

Actually simplest: just change the default value in config.ts from `'@bot'` to include `'c '` in the array directly, and document that triggers with significant trailing spaces can't be set via env var.

## No Conflicting Issues

9 open issues, none related to mention triggers.

## No Related Plans

`docs/plans/` has no mention trigger designs.

## Test Coverage

- `mentionDetector.test.ts` — 85 lines covering case-insensitivity, start-of-message, multiple triggers, special chars, whitespace normalization
- `config.test.ts:142-164` — Tests parsing, trimming, empty filtering

## Mock Server

- Trigger-agnostic — forwards all messages to the bot
- No changes needed for mock server itself
- Hardcoded hint says "claude:" but that's cosmetic

## Key Files
- `bot/src/config.ts` — **needs change** (trigger parsing/defaults)
- `bot/src/mentionDetector.ts` — no changes needed
- `bot/src/messageHandler.ts` — no changes needed
- `bot/.env.example` — update documentation
- `bot/tests/mentionDetector.test.ts` — add test cases
- `bot/tests/config.test.ts` — add test cases
