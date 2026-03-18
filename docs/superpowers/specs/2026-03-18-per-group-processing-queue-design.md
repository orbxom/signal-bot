# Per-Group Processing Queue

## Problem

When multiple people invoke Claude in the same Signal group within a short window, concurrent Claude invocations race against each other. The second invocation starts before the first response is stored in the database, so it doesn't see the first response in its context. This leads to duplicate or contradictory responses.

## Solution

A `GroupProcessingQueue` that serializes Claude invocations per group. Each group gets a FIFO queue — only one Claude process runs per group at a time. Non-trigger messages accumulate in the database naturally while Claude is working, so the next invocation gets full context.

## Architecture

### Types

```typescript
/** A single mention to process */
interface MentionRequest {
  groupId: string;
  sender: string;
  content: string;
  attachments: SignalAttachment[];
  timestamp: number;
}

/** A queue item — either a single mention or a coalesced batch of missed mentions */
type QueueItem =
  | { kind: 'single'; request: MentionRequest }
  | { kind: 'coalesced'; requests: MentionRequest[]; missedFraming: string };
```

The worker branches on `kind`: for `'single'`, it processes one mention. For `'coalesced'`, it processes all missed mentions as a single Claude invocation with the `missedFraming` string prepended to the query.

### GroupProcessingQueue (`bot/src/groupProcessingQueue.ts`)

New class that manages per-group async work queues.

```
GroupProcessingQueue
├── enqueue(item: QueueItem) → void
├── isProcessing(groupId) → boolean
├── getPendingCount(groupId) → number
└── shutdown() → void
```

**Constructor** takes a `processCallback: (item: QueueItem) => Promise<void>` — the function the worker calls to actually invoke the LLM. This is provided by the polling loop and wraps the MessageHandler processing path including `withTyping()`.

**Per-group state:**

- `queue: QueueItem[]` — pending work (FIFO)
- `processing: boolean` — whether a worker is active
- `lockTimeout: NodeJS.Timeout | null` — TTL safety timer

**Worker loop:** When an item is enqueued and no worker is running for that group, a worker starts. It pops from the queue, calls the `processCallback`, then checks for more work. When the queue is empty, the worker exits.

### Responsibility Ownership

Current responsibilities in `handleMessageBatch` and where they move:

| Responsibility | Current Owner | New Owner |
|---|---|---|
| Bot-self message filtering | `MessageHandler.handleMessageBatch` | Polling loop (before storage) |
| Deduplication | `MessageHandler.handleMessageBatch` | Polling loop (before storage) |
| Group-enabled check | `MessageHandler.handleMessageBatch` | Polling loop (skip enqueue for disabled groups) |
| Per-group custom trigger resolution | `MessageHandler.handleMessageBatch` | Polling loop (needs access to `storage.groupSettings`) |
| Message storage | `MessageHandler.handleMessageBatch` | Polling loop (store immediately for all messages) |
| Attachment ingestion | `MessageHandler.handleMessageBatch` | Polling loop (ingest after storage, skip for storeOnly groups) |
| Mention detection | `MessageHandler.handleMessageBatch` | Polling loop (detect after storage, before enqueue) |
| Missed/realtime classification | `MessageHandler.handleMessageBatch` | Polling loop (for coalescing decision only) |
| History fetch | `MessageHandler.processLlmRequest` | **Stays** — fetched fresh at processing time by the worker callback |
| Context building (dossiers, personas) | `MessageHandler.processLlmRequest` | **Stays** — built at processing time |
| LLM invocation | `MessageHandler.processLlmRequest` | **Stays** — called by queue worker via callback |
| Response storage | `MessageHandler.processLlmRequest` | **Stays** |
| Typing indicator | `MessageHandler.handleMessageBatch` | Worker callback wraps processing in `withTyping()` |

`handleMessageBatch` and `handleMessage` are both removed. `processLlmRequest` (or a public wrapper) becomes the sole entry point, called by the queue worker's callback.

### History Context: Avoiding Self-Duplication

The current code fetches history *before* storing the triggering message so it doesn't appear in its own context. With the new flow, messages are stored immediately at poll time, before enqueueing.

To prevent the triggering message from appearing in both the history and the query, the `MentionRequest` carries its `timestamp`. The history fetch excludes messages with `timestamp >= request.timestamp` from the same sender. This is simpler and more robust than matching on content (which is fragile if two messages have identical text).

### Polling Loop Changes (`bot/src/index.ts`)

**Current flow:** Poll → group messages → `await handleMessageBatch()` (blocks until Claude finishes)

**New flow:** Poll → filter (bot-self, dedup) → store all messages → ingest attachments → detect mentions → enqueue mentions into GroupProcessingQueue → continue polling without blocking

The polling loop needs access to `MentionDetector`, `MessageDeduplicator`, and `storage.groupSettings` (currently encapsulated in MessageHandler). These can be passed directly or extracted into a thin message ingestion helper.

### MessageHandler Changes (`bot/src/messageHandler.ts`)

Significantly simplified:

- `handleMessageBatch` and `handleMessage` are removed
- `processLlmRequest` becomes the public entry point (or is wrapped in a public method)
- `runMaintenance()` stays unchanged
- `assembleAdditionalContext()` stays unchanged
- The deduplicator, mention detector, and storage interactions for message ingestion move out

### Unchanged

- `claudeClient.ts` — no changes
- `spawnLimiter.ts` — still caps global concurrency at 2. At most 2 groups can have active Claude processes simultaneously. Per-group serialization means a single group holds at most 1 slot. No group can starve others — each group's worker awaits its turn via `SpawnLimiter.acquire()`.
- MCP servers — no changes

## Missed Message Coalescing

When the bot comes back online (restart, reconnection) and finds multiple old mentions in the same group from a single poll batch:

- Mentions older than `REALTIME_THRESHOLD_MS` (currently 5000ms, defined in `messageHandler.ts`) from the same poll batch are coalesced into a single `QueueItem` with `kind: 'coalesced'`
- The worker processes them as one Claude invocation with "you were offline and missed these messages" framing
- Realtime mentions from the same batch are enqueued individually after the coalesced item
- This avoids N separate Claude invocations for N mentions that accumulated while offline

Only groups that pass the storeOnly/enabled filters will have mentions enqueued. StoreOnly groups and disabled groups never produce queue items.

The 99% case is single mentions processed one at a time. Coalescing is a nice-to-have for restarts.

## Error Handling

### Lock TTL (Safety Valve)

The TTL timer starts **after `SpawnLimiter.acquire()` returns** — i.e., when Claude actually begins executing, not when the worker starts waiting for a slot. This prevents the TTL from firing while the worker is legitimately waiting for global concurrency to free up.

TTL duration: 6 minutes (the Claude CLI timeout is 5 minutes / 300,000ms; the extra minute provides buffer for semaphore acquisition overhead, arg building, and output parsing). If it fires:

- The lock is released and the worker moves to the next queued item
- A warning is logged at WARN level
- The hung Claude process is left to SpawnLimiter's existing SIGKILL escalation

### Processing Errors

If `processLlmRequest` throws (Claude crash, timeout, parse failure):

- The existing error message is sent to the group ("Sorry, I encountered an error...")
- The lock releases
- The worker moves to the next queued item
- One bad request does not poison the queue

### Queue Growth Cap

If a group's queue exceeds 10 pending mentions, new mentions are dropped with a WARN-level log. This prevents runaway queueing if Claude is consistently slow or failing for a group.

### Shutdown

`GroupProcessingQueue.shutdown()`:

- Clears all pending queues (queued-but-unprocessed mentions are silently dropped; a WARN log notes how many were discarded per group)
- Stops accepting new work (subsequent `enqueue()` calls are no-ops)
- Called from the existing shutdown handler in `index.ts` before `spawnLimiter.killAll()`
- In-flight Claude processes are cleaned up by SpawnLimiter as today

## Observability

Queue state logging:

- **INFO** on enqueue: group ID, queue depth after enqueue
- **INFO** on worker start/complete: group ID, processing duration
- **WARN** on TTL expiry, queue cap overflow, shutdown discards
- **DEBUG** on coalescing decisions (how many mentions coalesced)

## Testing

- Unit tests for `GroupProcessingQueue`: enqueue/dequeue ordering, per-group isolation (group A's queue doesn't block group B), TTL expiry releases lock, queue cap drops excess, shutdown clears queues and rejects new work, coalescing logic
- Unit tests for polling loop changes: bot-self filtering, dedup, mention detection, storeOnly groups don't enqueue, disabled groups don't enqueue
- Integration tests: verify that a second mention for the same group waits for the first to complete, and that its context includes the first response
