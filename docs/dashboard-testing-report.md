# Management Dashboard Testing Report

**Date:** 2026-04-11
**Branch:** `feature/management-dashboard` (PR #68)
**Tested by:** Claude (automated via curl + Playwright)

## Test Environment

- Mock signal server on port 9090
- Dashboard Express backend on port 3333 (`SIGNAL_CLI_URL=http://localhost:9090`)
- Vite frontend dev server on port 5173 (proxying `/api` to backend)
- Bot database: `bot/data/bot.db` (real data from prior mock/production runs)
- Playwright 1.58 (headless Chromium)

## Summary

| Severity | Count |
|----------|-------|
| Critical | 2 |
| High | 2 |
| Medium | 4 |
| Low | 2 |
| **Total** | **10** |

Bugs 1-4 are **blocking** -- they make core features non-functional. Bugs 5-8 are significant quality issues. Bugs 9-10 are polish.

---

## Critical

### BUG 1: All stats cards show "-" on Dashboard home page

**Page:** Dashboard (`/`)
**Files:** `dashboard/client/src/pages/Dashboard.tsx:15-20`, `dashboard/src/routes/health.ts:22-26`

**Steps to reproduce:** Navigate to `/`. Observe the "Active Groups", "Pending Reminders", and "Attachments" status cards.

**Expected:** Real counts (e.g. 5 groups, 50 reminders, 18 attachments as returned by the API).
**Actual:** All three cards show "-".

**Root cause:** The frontend `Stats` interface defines fields `{ messages, reminders, attachments, groups }` but the API returns `{ groupCount, reminderCount, attachmentCount, attachmentSize }`. None of the field names match, so `stats?.groups` etc. are always `undefined`, and the `??` fallback renders "-".

**Fix:** Align the `Stats` interface to match the API response:
```typescript
interface Stats {
  groupCount: number
  reminderCount: number
  attachmentCount: number
  attachmentSize: number
}
```
Then update the StatusCard references: `stats?.groupCount`, `stats?.reminderCount`, `stats?.attachmentCount`.

---

### BUG 2: GroupId `+` character not URL-encoded, breaking Messages page and GroupDetail tabs

**Pages:** Messages (`/messages`), GroupDetail (`/groups/:id`) tabs, filter inputs on Reminders/Dossiers/Memories
**Files:** `dashboard/client/src/pages/Messages.tsx:52`, `GroupDetail.tsx:78-80`, `Reminders.tsx:33,35`, `Dossiers.tsx:21`, `Memories.tsx:19`

**Steps to reproduce:**
1. Navigate to `/messages`
2. Select "Bot Test" from the group dropdown
3. Table shows "No messages found" despite the group having messages

**Expected:** Messages load and display.
**Actual:** 0 results returned.

**Root cause:** Signal group IDs contain `+` and `=` characters (e.g. `kKWs+FQPBZKe7N7CdxMjNAAjE2uWEmtBij55MOfWFU4=`). These are inserted directly into query parameters without `encodeURIComponent()`. Express's query parser interprets `+` as a space, so the groupId doesn't match any stored data.

**Verified with curl:**
```
GET /api/messages?groupId=kKWs+FQP...  -> []  (0 results, + read as space)
GET /api/messages?groupId=kKWs%2BFQP...  -> [3 messages]  (correctly encoded)
```

**Affected locations (all need `encodeURIComponent()`):**
| File | Line | URL Pattern |
|------|------|-------------|
| `Messages.tsx` | 52 | `/api/messages?groupId=${groupId}` |
| `GroupDetail.tsx` | 78 | `/api/reminders?groupId=${id}` |
| `GroupDetail.tsx` | 79 | `/api/dossiers?groupId=${id}` |
| `GroupDetail.tsx` | 80 | `/api/messages?groupId=${id}` |
| `Dossiers.tsx` | 21 | `/api/dossiers?groupId=${groupFilter}` |
| `Reminders.tsx` | 33 | `/api/reminders?groupId=${groupFilter}` |
| `Reminders.tsx` | 35 | `/api/recurring-reminders?groupId=${groupFilter}` |
| `Memories.tsx` | 19 | `/api/memories?groupId=${groupFilter}` |

Note: `Reminders.tsx:38,43` already correctly uses `encodeURIComponent()` for DELETE actions -- the inconsistency within the same file confirms this is an oversight.

---

## High

### BUG 3: Dashboard groups table "Last Activity" and "Messages" columns always empty

**Page:** Dashboard (`/`)
**File:** `dashboard/client/src/pages/Dashboard.tsx:22-29, 79-101`

**Steps to reproduce:** Navigate to `/`. Observe the groups table.

**Expected:** "Last Activity" shows a relative timestamp (e.g. "5m ago"), "Messages" shows a count.
**Actual:** "Last Activity" shows "Never" for all groups. "Messages" column is blank.

**Root cause:** The frontend `Group` interface expects `{ members: number, messageCount: number, lastActivity: string | null }` but the API (`GET /api/groups` via `enrichGroups()` in `dashboard/src/routes/groups.ts:8-18`) returns `{ members: string[], activePersona: string, enabled: boolean, settings: object | null }`. The `messageCount` and `lastActivity` fields don't exist in the API response.

**Fix options:**
- **Option A:** Add `messageCount` and `lastActivity` to the `enrichGroups` function by querying the message store
- **Option B:** Remove the "Last Activity" and "Messages" columns from the Dashboard groups table and show data that actually exists (e.g. "Members" count, "Persona")

---

### BUG 4: GroupDetail page stuck on "Loading..." forever (no error state handling)

**Page:** GroupDetail (`/groups/:id`)
**File:** `dashboard/client/src/pages/GroupDetail.tsx:86`

**Steps to reproduce:**
1. Navigate to `/groups`
2. Click on any group row
3. GroupDetail page shows "Loading..." and never resolves

**Expected:** Page displays group details, or shows an error message if the API fails.
**Actual:** "Loading..." displayed indefinitely.

**Root cause:** Two compounding issues:
1. The mock signal server lacks a `getGroup` RPC handler, so `GET /api/groups/:id` returns 503
2. The component only checks `loading` and `data` on line 86: `if (loading || !group) return <div className="loading">Loading...</div>`. When `useApi` finishes with an error, `loading` becomes `false` but `data` remains `null`. Since `!group` is `true`, the component renders "Loading..." -- which is incorrect for an error state.

**Fix:** Check the `error` return from `useApi` and render an appropriate error state:
```tsx
const { data: group, loading, error, refetch } = useApi<GroupDetailData>(...)
if (loading) return <div className="loading">Loading...</div>
if (error || !group) return <div className="error">Failed to load group details: {error}</div>
```

This same pattern issue likely exists on other pages that use `useApi` -- any page that only checks `loading || !data` without checking `error` will show "Loading..." on API failure.

---

## Medium

### BUG 5: Factory WebSocket events never reach the frontend

**File:** `dashboard/src/server.ts:39,64`

**Steps to reproduce:** Open `/factory` while factory runs are active. Changes to factory run files are not reflected in real-time.

**Expected:** Factory run status, diary, and event updates push to the browser via WebSocket.
**Actual:** Updates never arrive. The "Live" indicator shows connected, but no `factory:update` events are received.

**Root cause:** `server.ts` creates `FactoryService` (line 39) and calls `factoryService.start()` (line 64) but never subscribes to its `'update'` events. The `FactoryService` extends `EventEmitter` and emits `'update'` when files change, but nothing bridges these events to the `WebSocketHub`.

The frontend (`Factory.tsx:258-276`) has a complete `onWsEvent` handler for `factory:update` events -- the client-side code is correct but will never fire.

**Fix:** Add to `server.ts` after line 64:
```typescript
factoryService.on('update', (msg) => wsHub.broadcast({ type: 'factory:update', data: msg }));
```

---

### BUG 6: Mock signal server missing 3 RPC handlers needed by dashboard

**File:** `bot/src/mock/signalServer.ts` (handlers object, ~line 130)

The mock signal server only implements 4 RPC methods: `receive`, `send`, `sendTyping`, `listGroups`. The dashboard requires 3 additional methods:

| Method | Used by | Effect when missing |
|--------|---------|-------------------|
| `getGroup` | `GET /api/groups/:id` (GroupDetail page) | Returns 503, page stuck on Loading |
| `quitGroup` | `POST /api/groups/:id/leave` (Leave Group button) | Returns 500 |
| `joinGroup` | `POST /api/groups/join` (Join Group form) | Returns 422 |

This makes the GroupDetail page, leave group, and join group features untestable in mock mode.

---

### BUG 7: Messages page fires wasteful API call with `groupId=_none_`

**File:** `dashboard/client/src/pages/Messages.tsx:55`

**Steps to reproduce:** Navigate to `/messages` without selecting a group.

**Expected:** No API call until a group is selected.
**Actual:** `useApi` is immediately called with `/api/messages?groupId=_none_`, hitting the server and returning an empty array.

**Root cause:** The `useApi` hook doesn't support conditional/deferred fetching. The Messages page works around this with a ternary that falls back to a dummy URL:
```typescript
const { data: messages, loading } = useApi<Message[]>(url ?? '/api/messages?groupId=_none_', [groupId, searchQuery])
```

**Fix:** Either add a `skip` option to `useApi` (e.g. `useApi<T>(url: string | null, ...)` that skips fetching when `null`), or guard the fetch inside the hook when the URL contains a sentinel value.

---

### BUG 8: No error handling on mutation actions (unhandled promise rejections)

**Files:**
| File | Functions |
|------|-----------|
| `GroupDetail.tsx:103-107` | `handleLeave()`, `handleToggleEnabled()` |
| `Personas.tsx:23-32, 41-48, 50-53` | `createPersona()`, `saveEdit()`, `deletePersona()` |
| `Dossiers.tsx:29-37, 39-42` | `saveEdit()`, `deleteDossier()` |
| `Memories.tsx` | `saveEdit()`, `deleteMemory()` |
| `Attachments.tsx:30-33` | `handleDelete()` |

All these functions `await apiCall(...)` without try/catch. If the API returns an error, the promise rejection goes unhandled. The user sees no feedback, and any code after the `await` (like `refetch()`) never executes.

Note: `GroupDetail.tsx:90-101` (`handleSaveSettings`) correctly uses try/finally -- it's the only mutation handler with error handling, making the omission elsewhere clearly an oversight.

---

## Low

### BUG 9: Dashboard WebSocket connection is a no-op

**File:** `dashboard/client/src/pages/Dashboard.tsx:130-132`

The `onWsEvent` callback is empty with a comment "could trigger refetches in the future". The WebSocket connects and the connection indicator works, but incoming events (new messages, reminder status changes broadcast by `DbPoller`) don't trigger any UI updates. The Dashboard page only refreshes on manual page reload.

---

### BUG 10: No confirmation dialogs before destructive delete actions

**Pages:** Dossiers, Personas, Memories, Attachments

Delete buttons on all CRUD pages immediately fire the API call with no confirmation dialog. This is inconsistent with the GroupDetail page, where "Leave Group" does have a confirmation step (`leaveConfirm` state in `GroupDetail.tsx:84,158-168`).

---

## Pages That Work Correctly

- **Sidebar navigation** -- all 9 links route correctly, active state highlights work
- **Groups list** (`/groups`) -- table loads, join form shows errors/success, row click navigates
- **Reminders** (`/reminders`) -- both tables render, filter works (though not debounced), cancel/reset buttons function
- **Personas** (`/personas`) -- CRUD works, default persona protection correct (no delete button)
- **Dossiers** (`/dossiers`) -- list, edit, delete all functional
- **Memories** (`/memories`) -- list, edit, delete all functional
- **Attachments** (`/attachments`) -- stats cards display correctly, image previews load, storage-by-group table renders
- **Factory** (`/factory`) -- initial data loads from API, run cards render with stage bars and diary panels
- **Health endpoint** -- correctly reports signal-cli reachability, uptime, DB size, memory

## Notes

- The `Members` column on the Groups page (`/groups`) shows "0" because the mock `listGroups` returns no `members` array (only `id`, `name`, `isMember`). With real signal-cli this would return actual member lists. Not filed as a bug since it's a mock limitation, not a code defect.
- The `useApi` hook lacks an `AbortController`, which could cause state-update-after-unmount warnings on fast navigation. Not observed during testing but worth noting for future hardening.
