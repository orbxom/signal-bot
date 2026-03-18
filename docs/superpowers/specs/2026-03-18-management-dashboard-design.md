# Management Dashboard Design

## Overview

A unified management dashboard for the Signal Family Bot. Combines ops monitoring, data management, and group lifecycle management into a single web app. Also hosts the existing Dark Factory pipeline dashboard as a tab.

**Audience:** Single admin (localhost only, no auth).

## Architecture

### Unified Server (Express + Vite + WebSocket)

A single Express server that:

- Serves the React SPA (Vite-built static files in prod, Vite dev server proxy in dev)
- Exposes a REST API at `/api/*`
- Provides WebSocket at `/ws` for real-time updates
- Queries the bot's SQLite DB directly via the existing store classes
- Talks to signal-cli's HTTP API for group management
- Watches `factory/runs/` for dark factory pipeline updates

```
Dashboard Server (Express + Vite)
├── REST API (/api/*)
├── WebSocket (/ws)
├── Static/Vite (React SPA)
└── Service Layer
    ├── SQLite (bot.db) — via shared store classes
    ├── signal-cli (:8080) — group management
    └── factory/runs/ (Chokidar file watch)
```

The dashboard runs as a **separate process** from the bot. It opens the bot's SQLite DB in WAL mode (safe for concurrent readers). Write operations (cancel reminder, delete dossier, etc.) go through the same DB. Signal group operations go through signal-cli's HTTP API directly.

### Shared Store Reuse

The dashboard imports the bot's existing store classes (`MessageStore`, `ReminderStore`, `DossierStore`, etc.) via a TypeScript path alias or workspace reference. This avoids duplicating DB logic and means schema migrations automatically apply to both the bot and the dashboard.

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
- **Settings** — per-group configuration (enabled/disabled, custom triggers, context window size)

## REST API

### Health & Status

- `GET /api/health` — bot uptime, DB size, signal-cli reachability, memory usage
- `GET /api/stats` — aggregate counts (messages, reminders, attachments, groups)

### Groups

- `GET /api/groups` — list all groups (from signal-cli + enriched with DB stats)
- `GET /api/groups/:id` — group detail (members, message count, active persona, settings)
- `POST /api/groups/:id/join` — join a group (via signal-cli)
- `POST /api/groups/:id/leave` — leave a group (via signal-cli)
- `PATCH /api/groups/:id/settings` — update per-group config (enabled/disabled, mention triggers, tool notifications)

### Reminders

- `GET /api/reminders?groupId=&status=` — list with filters
- `DELETE /api/reminders/:id` — cancel a reminder
- `GET /api/recurring-reminders?groupId=` — list recurring
- `DELETE /api/recurring-reminders/:id` — cancel recurring
- `POST /api/recurring-reminders/:id/reset-failures` — reset failure counter

### Dossiers

- `GET /api/dossiers?groupId=` — list dossiers
- `GET /api/dossiers/:id` — get one
- `PUT /api/dossiers/:id` — update
- `DELETE /api/dossiers/:id` — delete

### Personas

- `GET /api/personas` — list all
- `POST /api/personas` — create
- `PUT /api/personas/:id` — update
- `DELETE /api/personas/:id` — delete
- `POST /api/groups/:groupId/persona` — activate persona for group

### Memories

- `GET /api/memories?groupId=` — list
- `PUT /api/memories/:id` — update
- `DELETE /api/memories/:id` — delete

### Messages

- `GET /api/messages?groupId=&search=&from=&to=` — search/browse (read-only)

### Attachments

- `GET /api/attachments?groupId=` — list metadata (no blob)
- `GET /api/attachments/:id/image` — serve the actual image
- `DELETE /api/attachments/:id` — delete
- `GET /api/attachments/stats` — storage usage breakdown

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

### Observing Bot Activity

The dashboard is a separate process from the bot. It detects bot activity by **polling the SQLite DB every 2-3 seconds**, detecting new rows (messages, reminder status changes), and pushing WebSocket events to connected clients. WAL mode ensures reads don't block the bot's writes.

## Group Management

### signal-cli Integration

The dashboard talks to signal-cli's HTTP API for group operations:

- `GET /v1/groups/{number}` — list all groups
- `GET /v1/groups/{number}/{groupId}` — group details (name, members, admins)
- `POST /v1/groups/{number}/{groupId}/quit` — leave a group

### Enable/Disable vs Leave

- **Disable** — adds group ID to a `group_settings` table with `enabled = 0`. The bot's polling loop checks this before processing messages. Reversible.
- **Leave** — actually leaves the Signal group via signal-cli. Destructive, requires confirmation in UI. DB data is retained, group marked as "left."

### Join Limitation

Signal does not allow bots to self-join groups. Someone must invite the bot's phone number. The dashboard UI shows the bot's phone number and a "waiting for invite" state. No programmatic join is possible.

### New DB Table

```sql
CREATE TABLE group_settings (
  groupId TEXT PRIMARY KEY,
  enabled INTEGER DEFAULT 1,
  customTriggers TEXT,          -- JSON array, null = use global
  contextWindowSize INTEGER,    -- null = use global default
  createdAt TEXT,
  updatedAt TEXT
);
```

The bot reads this table at message-processing time to check if a group is enabled and what triggers/settings to use.

## Project Structure

```
dashboard/
  src/
    server.ts              # Express + WebSocket + Vite middleware
    services/
      signalService.ts     # signal-cli HTTP API wrapper
      healthService.ts     # Health checks & stats
      factoryService.ts    # Factory run file watcher (migrated)
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
        Factory.tsx         # Dark factory pipeline (migrated)
      components/
        Sidebar.tsx
        StatusCard.tsx
        DataTable.tsx
        ...
      hooks/
        useWebSocket.ts
        useApi.ts
      vite.config.ts
```

## Error Handling

| Scenario | Behavior |
|----------|----------|
| **signal-cli down** | Health shows degraded, group management returns clear errors, all DB features still work, UI shows warning banner |
| **Bot not running** | Dashboard still works (reads DB directly), health check detects stale timestamps, shows "Bot offline" |
| **DB locked** | API returns 503 with retry-after, frontend shows transient toast, auto-retry |
| **Stale group data** | Reconcile signal-cli group list with DB — mark removed groups as "removed externally", retain data for history |
| **Factory dir missing** | Factory tab shows "No runs found", no crash |
