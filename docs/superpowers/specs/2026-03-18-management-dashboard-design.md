# Management Dashboard Design

## Overview

A unified management dashboard for the Signal Family Bot. Combines ops monitoring, data management, and group lifecycle management into a single web app. Also hosts the existing Dark Factory pipeline dashboard as a tab.

**Audience:** Single admin (localhost only, no auth). The Express server binds to `127.0.0.1` to prevent accidental network exposure.

## Architecture

### Unified Server (Express + Vite + WebSocket)

A single Express server that:

- Serves the React SPA (Vite-built static files in prod, Vite dev server proxy in dev)
- Exposes a REST API at `/api/*`
- Provides WebSocket at `/ws` for real-time updates
- Queries the bot's SQLite DB directly via the existing store classes
- Talks to signal-cli via JSON-RPC for group management
- Watches `factory/runs/` for dark factory pipeline updates

```
Dashboard Server (Express + Vite)
├── REST API (/api/*)
├── WebSocket (/ws)
├── Static/Vite (React SPA)
└── Service Layer
    ├── SQLite (bot.db) — via shared store classes
    ├── signal-cli (:8080) — via shared SignalClient (JSON-RPC)
    └── factory/runs/ (Chokidar file watch)
```

The dashboard runs as a **separate process** from the bot. It opens the bot's SQLite DB in WAL mode (safe for concurrent readers). Write operations (cancel reminder, delete dossier, etc.) go through the same DB. Signal group operations go through signal-cli's JSON-RPC API.

### Shared Code Reuse

The dashboard imports from the bot via TypeScript path aliases or workspace references:

- **Store classes** (`MessageStore`, `ReminderStore`, `DossierStore`, etc.) — avoids duplicating DB logic, schema migrations automatically apply to both
- **`SignalClient`** (`bot/src/signalClient.ts`) — reuses the existing JSON-RPC wrapper for signal-cli communication rather than creating a parallel implementation
- **`DatabaseConnection`** (`bot/src/db.ts`) — same connection class, WAL mode

### Dev vs Prod

- **Dev:** Vite dev server runs on its own port, proxies `/api/*` and `/ws` requests to the Express server. Standard Vite proxy config.
- **Prod:** Express serves the Vite-built static files from `dashboard/client/dist/`.

## Frontend

### Tech Stack

- React 18+ with Vite
- React Router for navigation
- WebSocket for real-time updates (custom `useWebSocket` hook)

### Navigation

Sidebar navigation with these top-level views:

| View | Purpose |
|------|---------|
| **Dashboard** | Health overview, key metrics, group list, recurring reminder status |
| **Groups** | List all groups, drill into per-group management |
| **Reminders** | All reminders across groups (one-off + recurring) |
| **Dossiers** | All person profiles across groups |
| **Personas** | Manage bot personalities |
| **Memories** | Group knowledge base entries |
| **Messages** | Search/browse message history (read-only) |
| **Attachments** | Browse images, storage usage |
| **Factory** | Dark factory pipeline view (migrated from existing dashboard) |

### Dashboard Home Page

Displays:

- **Bot health status** — uptime, memory, DB size, signal-cli reachability
- **Active groups** — list with last activity time, message count, quick "Manage" link
- **Pending reminders** — count + any failed reminders
- **Recurring reminder status** — next due, recent failures
- **Attachment storage** — total size, image count

### Group Detail Page

Tabbed view when drilling into a group:

- **Overview** — status (enabled/disabled), active persona, member count, tool notification setting, action buttons (disable, change persona, leave group)
- **Reminders** — per-group one-off and recurring reminders
- **Dossiers** — person profiles in this group
- **Persona** — currently active persona, switch
- **Memories** — knowledge base entries for this group
- **Messages** — message history for this group
- **Settings** — per-group configuration (enabled/disabled, custom triggers, context window size, tool notifications)

## REST API

All list endpoints support pagination via `?limit=&offset=` query parameters. Default limit is 50, max is 200.

### Health & Status

- `GET /api/health` — bot uptime, DB size, signal-cli reachability, memory usage
- `GET /api/stats` — aggregate counts (messages, reminders, attachments, groups)

### Groups

- `GET /api/groups` — list all groups (from signal-cli + enriched with DB stats)
- `GET /api/groups/:id` — group detail (members, message count, active persona, settings)
- `POST /api/groups/:id/leave` — leave a group (via signal-cli JSON-RPC). Destructive, UI requires confirmation.
- `PATCH /api/groups/:id/settings` — update per-group config (enabled/disabled, mention triggers, context window size, tool notifications)

Note: No join endpoint. Signal does not support programmatic group joins — see Group Management section.

### Reminders

- `GET /api/reminders?groupId=&status=&limit=&offset=` — list with filters. `groupId` optional (all groups if omitted).
- `DELETE /api/reminders/:id?groupId=` — cancel a reminder. `groupId` required (matches existing store safety guard).
- `GET /api/recurring-reminders?groupId=&limit=&offset=` — list recurring. `groupId` optional.
- `DELETE /api/recurring-reminders/:id?groupId=` — cancel recurring. `groupId` required (matches existing store safety guard).
- `POST /api/recurring-reminders/:id/reset-failures` — reset consecutive failure counter

### Dossiers

Dossiers use composite keys (`groupId` + `personId`), not integer IDs.

- `GET /api/dossiers?groupId=&limit=&offset=` — list dossiers. `groupId` optional (all groups if omitted).
- `GET /api/dossiers/:groupId/:personId` — get one
- `PUT /api/dossiers/:groupId/:personId` — update (body: `{ displayName, notes }`)
- `DELETE /api/dossiers/:groupId/:personId` — delete

### Personas

- `GET /api/personas` — list all
- `POST /api/personas` — create
- `PUT /api/personas/:id` — update
- `DELETE /api/personas/:id` — delete
- `POST /api/groups/:groupId/persona` — activate persona for group (body: `{ personaId }`)

### Memories

Memories use composite keys (`groupId` + `topic`).

- `GET /api/memories?groupId=&limit=&offset=` — list. `groupId` optional (all groups if omitted).
- `PUT /api/memories/:groupId/:topic` — update (body: `{ content }`)
- `DELETE /api/memories/:groupId/:topic` — delete

### Messages

- `GET /api/messages?groupId=&search=&from=&to=&limit=&offset=` — search/browse (read-only). `groupId` required (message tables can be very large; cross-group queries are not supported).

### Attachments

- `GET /api/attachments?groupId=&limit=&offset=` — list metadata (no blob). `groupId` optional.
- `GET /api/attachments/:id/image` — serve the actual image (binary response)
- `DELETE /api/attachments/:id` — delete
- `GET /api/attachments/stats` — storage usage breakdown (total size, count per group)

### Factory

- `GET /api/factory/runs` — list factory runs (from file system)

## WebSocket Events

Real-time events pushed to all connected dashboard clients:

| Event | Trigger | Data |
|-------|---------|------|
| `health:update` | Every 10s | uptime, memory, signalCli status, dbSize |
| `message:new` | Bot receives a message | groupId, sender, preview (first ~100 chars), timestamp, isBot |
| `reminder:due` | Reminder fires | id, groupId, text |
| `reminder:failed` | Reminder delivery fails | id, retryCount, error |
| `factory:update` | Factory run status change | runId, stage, status |

### Observing Bot Activity (DB Polling)

The dashboard is a separate process from the bot. It detects bot activity by polling the SQLite DB every 2-3 seconds:

**Change detection mechanism:**
- **Messages:** Track highest known `rowid` in the `messages` table. Each poll queries `SELECT * FROM messages WHERE rowid > ? ORDER BY rowid LIMIT 50`. New rows trigger `message:new` WebSocket events.
- **Reminders:** Query `SELECT * FROM reminders WHERE status = 'sent' AND rowid > ?` and `WHERE status = 'failed' AND rowid > ?` to detect status transitions. Track last-seen rowid per status.
- **Recurring reminders:** Query `SELECT * FROM recurring_reminders WHERE lastFiredAt > ?` to detect recent firings. Track last-seen timestamp.
- **Health:** Every 10s, ping signal-cli via `SignalClient`, read `process.memoryUsage()`, check DB file size via `fs.stat()`.

Each poller maintains its own high-water mark (rowid or timestamp) in memory. On dashboard restart, it initializes from the current max values (no historical replay).

WAL mode ensures these reads don't block the bot's writes.

## Group Management

### signal-cli Integration (JSON-RPC)

The dashboard reuses the bot's `SignalClient` class, which communicates via JSON-RPC at `POST /api/v1/rpc`. Relevant RPC methods:

- `listGroups` — list all groups the bot's number is in
- `getGroup` — group details (name, members, admins) for a specific group
- `quitGroup` — leave a group

### Enable/Disable vs Leave

- **Disable** — sets `enabled = 0` in the `group_settings` table. The bot's polling loop checks this before processing messages. Reversible.
- **Leave** — calls `quitGroup` via signal-cli JSON-RPC. Destructive, requires confirmation in UI. DB data is retained, group marked as "left."

### Join Limitation

Signal does not allow bots to self-join groups. Someone must invite the bot's phone number. The dashboard UI shows the bot's phone number for manual invitation and displays groups in a "waiting for invite" or "not a member" state when signal-cli reports them as left/removed.

### New DB Table: `group_settings`

```sql
CREATE TABLE group_settings (
  groupId TEXT PRIMARY KEY,
  enabled INTEGER DEFAULT 1,
  customTriggers TEXT,          -- JSON array, null = use global
  contextWindowSize INTEGER,    -- null = use global default
  toolNotifications INTEGER DEFAULT 1,
  createdAt INTEGER,
  updatedAt INTEGER
);
```

**Replaces `tool_notification_settings` table.** The existing `tool_notification_settings` table stores only `(groupId, enabled)` for tool notifications. The new `group_settings` table subsumes this with the `toolNotifications` column. A migration (V8) will:
1. Create `group_settings`
2. Copy existing rows from `tool_notification_settings` into `group_settings.toolNotifications`
3. Drop `tool_notification_settings`

The `ToolNotificationStore` is replaced by a new `GroupSettingsStore` in `bot/src/stores/groupSettingsStore.ts`.

### Required Bot Code Changes

The bot must be updated to read `group_settings` at runtime:

1. **New `GroupSettingsStore`** (`bot/src/stores/groupSettingsStore.ts`) — CRUD for `group_settings` table. Methods: `get(groupId)`, `upsert(groupId, settings)`, `isEnabled(groupId)`, `getTriggers(groupId)`, `getToolNotifications(groupId)`.
2. **`MessageHandler` change** — before processing a group's messages, check `groupSettingsStore.isEnabled(groupId)`. If disabled, skip processing (but still store messages for history).
3. **Per-group trigger resolution** — `MessageHandler` (or `index.ts`) resolves triggers per-group by checking `groupSettingsStore.getTriggers(groupId)`, falling back to the global `MENTION_TRIGGERS` env var. The resolved triggers are passed to `MentionDetector` (which is already stateless and accepts triggers via constructor). No changes to `MentionDetector` itself.
4. **`Storage` facade** — add `groupSettings` property delegating to `GroupSettingsStore`.
5. **Migration V8** in `db.ts` — create table, migrate data, drop old table.

## New SignalClient Methods Required

The existing `SignalClient` (`bot/src/signalClient.ts`) exposes `sendMessage`, `sendTyping`, `stopTyping`, `receiveMessages`, `waitForReady`, `readAttachmentFile`, and `extractMessageData`. The dashboard needs three additional public methods:

- `listGroups()` — list all groups the bot's number is in. (The RPC call already exists internally in `waitForReady()` but is not exposed.)
- `getGroup(groupId: string)` — get group details (name, members, admins)
- `quitGroup(groupId: string)` — leave a group

## New Store Methods Required

Several dashboard API endpoints require queries the existing stores don't support. New methods needed:

### ReminderStore
- `listAll(filters?: { groupId?, status?, limit?, offset? })` — list reminders across all groups with optional filters

### RecurringReminderStore
- `listAll(filters?: { groupId?, limit?, offset? })` — list recurring reminders across all groups
- `resetFailures(id: number)` — set `consecutiveFailures = 0` for a given reminder

### DossierStore
- `listAll(filters?: { groupId?, limit?, offset? })` — list dossiers across all groups (currently only `getByGroup()` exists)

### MemoryStore
- `listAll(filters?: { groupId?, limit?, offset? })` — list memories across all groups

### AttachmentStore
- `listMetadata(filters?: { groupId?, limit?, offset? })` — list attachment rows **without** the BLOB `data` column
- `getStats()` — return total size and count per group (aggregate query)
- `deleteById(id: string)` — delete a single attachment by ID

## Project Structure

```
dashboard/
  src/
    server.ts              # Express + WebSocket + Vite middleware
    services/
      healthService.ts     # Health checks & stats (pings signal-cli, reads process stats)
      factoryService.ts    # Factory run file watcher (migrated from existing dashboard)
      dbPoller.ts          # Polls SQLite for changes, emits WebSocket events
    routes/
      groups.ts            # /api/groups/*
      reminders.ts         # /api/reminders/*
      dossiers.ts          # /api/dossiers/*
      personas.ts          # /api/personas/*
      memories.ts          # /api/memories/*
      messages.ts          # /api/messages/*
      attachments.ts       # /api/attachments/*
      factory.ts           # /api/factory/*
      health.ts            # /api/health, /api/stats
    websocket.ts           # WebSocket event hub
  client/
    src/
      App.tsx
      pages/
        Dashboard.tsx       # Home — health, groups, reminders overview
        Groups.tsx          # Group list
        GroupDetail.tsx     # Per-group tabbed view
        Reminders.tsx       # All reminders across groups
        Dossiers.tsx        # All dossiers across groups
        Personas.tsx        # Persona management
        Memories.tsx        # Memory management
        Messages.tsx        # Message search/browse
        Attachments.tsx     # Attachment browser + storage stats
        Factory.tsx         # Dark factory pipeline (rewritten in React)
      components/
        Sidebar.tsx
        StatusCard.tsx
        DataTable.tsx
        ...
      hooks/
        useWebSocket.ts
        useApi.ts
    vite.config.ts         # Includes proxy config for /api/* and /ws to Express in dev
```

### Factory Migration

The existing Dark Factory dashboard (`dashboard/public/index.html`, Preact SPA) is **replaced** by:

- **Backend:** `factoryService.ts` takes over the Chokidar file watcher logic from the current `dashboard/src/watcher.ts`. Factory WebSocket events are pushed through the same WebSocket hub as all other events.
- **Frontend:** `Factory.tsx` is a full React rewrite of the existing Preact dashboard. Same functionality (pipeline cards, stage progress bars, diary panels) but using React components consistent with the rest of the dashboard.
- **Removal:** The current `dashboard/public/` directory and standalone Preact server are removed once the migration is complete.

## Error Handling

| Scenario | Behavior |
|----------|----------|
| **signal-cli down** | Health shows degraded, group management returns clear errors, all DB features still work, UI shows warning banner |
| **Bot not running** | Dashboard still works (reads DB directly), health check detects stale timestamps, shows "Bot offline" |
| **DB locked** | API returns 503 with retry-after, frontend shows transient toast, auto-retry |
| **Stale group data** | Reconcile signal-cli group list with DB — mark removed groups as "removed externally", retain data for history |
| **Factory dir missing** | Factory tab shows "No runs found", no crash |
