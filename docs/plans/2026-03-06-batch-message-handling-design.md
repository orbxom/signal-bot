# Batch Message Handling Design

## Problem

When the bot is offline and comes back, it processes each queued message individually. If multiple messages contain mention triggers, each gets its own LLM call and response, resulting in repetitive replies (e.g., five "Yeah mate, I'm here" responses).

## Solution

Batch messages per group within each poll cycle. Classify mentions as "missed" or "real-time" based on timestamp age. Missed mentions get a single batched LLM call with explicit framing; real-time mentions are processed individually as before.

## Design

### Batch grouping in `index.ts`

After `receiveMessages()`, group extracted messages by `groupId` into a Map. Call `messageHandler.handleMessageBatch(groupId, messages)` per group instead of individual `handleMessage()` calls.

### `handleMessageBatch()` in `messageHandler.ts`

1. Filter bot's own messages and duplicates
2. Store all messages to DB
3. Detect which messages contain mentions
4. If no mentions, return early
5. Classify mentions by timestamp:
   - **Real-time**: `now - timestamp <= REALTIME_THRESHOLD_MS` (5s)
   - **Missed**: older than the threshold
6. If multiple missed mentions: single LLM call with "you were offline" framing
7. If one missed mention: process individually (normal path)
8. Real-time mentions: process individually (normal path)

### Missed message framing

When batching missed mentions, inject a note into the LLM context:

```
You were offline and missed the following messages:
- [+61400111222] (3 min ago): "claude: you awake buddy?"
- [+61400111222] (2 min ago): "claude: You awake buddy?"
- [+61400333444] (1 min ago): "claude: what's the weather?"

Respond to all of these in a single message.
```

The latest mention is used as the primary query. History is fetched from before the batch (same as today).

### Backward compatibility

`handleMessage()` remains as a convenience wrapper around a single-element batch. Existing tests pass unchanged.

### Constants

- `REALTIME_THRESHOLD_MS = 5000` — Messages within 5s of current time are "real-time" (accounts for poll interval + signal-cli jitter)

## Test Plan (TDD, red-green-refactor)

New file: `messageHandler.batch.test.ts`

1. Single message batch behaves identically to current `handleMessage`
2. Multiple mentions, all missed: one LLM call, all messages stored
3. Multiple mentions, all real-time: each gets its own LLM call
4. Mix of missed + real-time: missed batched, real-time individual
5. Batch with no mentions: all stored, no LLM call
6. "You were offline" framing present in context for batched calls
7. Bot's own messages filtered from batch
8. Duplicates filtered from batch

## Files Changed

- `bot/src/messageHandler.ts` — Add `handleMessageBatch()`, `REALTIME_THRESHOLD_MS` constant, missed-message framing logic
- `bot/src/index.ts` — Replace per-message loop with group-by + batch call
- `bot/src/messageHandler.batch.test.ts` — New test file
