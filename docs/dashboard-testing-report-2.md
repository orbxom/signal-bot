# Management Dashboard Testing Report #2

**Date:** 2026-04-11
**Branch:** `feature/management-dashboard` (commit `e6c1ed8`)
**Tested by:** Claude (automated via curl API testing + Playwright headless Chromium)
**Previous report:** `docs/dashboard-testing-report.md` — all 10 bugs from that report are now fixed

## Test Environment

- Mock signal server on port 9090 (`bot/src/mock/signalServer.ts`)
- Dashboard Express backend on port 3333 (`SIGNAL_CLI_URL=http://localhost:9090`, `DB_PATH=bot/data/mock-bot.db`)
- Built React client served via Express static middleware
- Playwright 1.59 (headless Chromium)
- All 987 bot tests and 71 dashboard tests passing

## Summary

| Severity | Count |
|----------|-------|
| Critical | 1 |
| High     | 1 |
| Medium   | 3 |
| Low      | 3 |
| **Total** | **8** |

---

## Critical

### BUG 1: GroupDetail Reminders tab crashes the entire app (field name mismatch)

**Page:** GroupDetail (`/groups/:id`) → Reminders tab
**File:** `dashboard/client/src/pages/GroupDetail.tsx:40-56`

**Steps to reproduce:**
1. Navigate to `/groups`
2. Click on "Bot Test" (or any group with reminders)
3. Click the "Reminders" tab

**Expected:** Reminders table shows reminders for the group.
**Actual:** Entire page goes blank — sidebar, heading, tabs all disappear. No error message shown.

**Root cause:** The `Reminder` interface in GroupDetail.tsx defines `text: string` (line 40), but the API returns `reminderText`. The column render function accesses `r.text.length` (line 51), which throws `TypeError: Cannot read properties of undefined (reading 'length')`. Since there is no React error boundary, the error propagates and unmounts the entire component tree, leaving a blank page.

**Verified with Playwright:**
```
Console errors: TypeError: Cannot read properties of undefined (reading 'length')
Rendered: tables=0, empty=0, loading=0, error=0, tabBtns=0
```

Screenshot shows completely blank page (no sidebar, no content).

**Comparison:** The standalone Reminders page (`/reminders`) uses the correct field name `reminderText` in its interface and renders correctly. The bug is only in GroupDetail.tsx.

**Fix:** Change the interface and column definition:
```diff
 interface Reminder {
   ...
-  text: string
+  reminderText: string
   ...
 }

 const reminderColumns = [
   ...
-  { key: 'text', header: 'Text', render: (r: Reminder) => (
-    <span title={r.text}>{r.text.length > 50 ? r.text.slice(0, 50) + '...' : r.text}</span>
+  { key: 'reminderText', header: 'Text', render: (r: Reminder) => (
+    <span title={r.reminderText}>{r.reminderText.length > 50 ? r.reminderText.slice(0, 50) + '...' : r.reminderText}</span>
   )},
   ...
 ]
```

Also consider adding a React error boundary at the route level to prevent individual page crashes from blanking the entire app.

---

## High

### BUG 2: Dashboard server crashes on startup if `BOT_PHONE_NUMBER` not set

**File:** `dashboard/src/server.ts:23,28`

**Steps to reproduce:** Start the dashboard without setting `BOT_PHONE_NUMBER`:
```bash
DB_PATH=./bot/data/bot.db SIGNAL_CLI_URL=http://localhost:9090 npx tsx src/server.ts
```

**Expected:** Dashboard starts (perhaps with signal-cli features degraded).
**Actual:** Immediate crash:
```
Error: Account is required
    at new SignalClient (bot/src/signalClient.ts:16:13)
```

**Root cause:** `server.ts` line 23 defaults `BOT_PHONE_NUMBER` to `''` (empty string). `SignalClient` constructor throws on empty account (line 16). The dashboard becomes impossible to start without knowing the phone number, which is not documented in the dashboard README.

**Fix options:**
- Document `BOT_PHONE_NUMBER` as a required env var for dashboard startup
- Or defer `SignalClient` creation and gracefully degrade signal-dependent features (groups list, join/leave) when the phone number is not configured
- Or read `BOT_PHONE_NUMBER` from `bot/.env` via dotenv

---

## Medium

### BUG 3: Delete/cancel operations return 200 with `{success: false}` — no user feedback

**Files:** `dashboard/src/routes/reminders.ts:24`, `dashboard/src/routes/personas.ts:26`, `dashboard/src/routes/attachments.ts:33`

**Steps to reproduce:**
1. Trigger a delete on a non-existent resource (race condition, already deleted by another client, etc.)

**Expected:** User sees an error message indicating the operation failed.
**Actual:** The API returns HTTP 200 with `{"success": false}`. The frontend's `apiCall()` only checks `res.ok`, so it treats this as success. The `refetch()` call runs, the data reloads, but no error is shown.

**Verified with curl:**
```bash
curl -X DELETE http://localhost:3333/api/personas/9999
# → 200 {"success":false}

curl -X DELETE "http://localhost:3333/api/reminders/9999?groupId=fake"
# → 200 {"success":false}
```

**Fix:** Either return 404 status when the resource doesn't exist, or check `success` in the frontend response handling.

---

### BUG 4: GroupDetail settings form doesn't reset on refetch

**File:** `dashboard/client/src/pages/GroupDetail.tsx:83`

**Steps to reproduce:**
1. Navigate to a group's Settings tab
2. Change a setting (e.g., toggle "Enabled")
3. Click "Save Settings"
4. The saved value is reflected, but `settingsForm` state retains the override
5. Switch to Overview tab and back to Settings — the form shows the merged state (partial override persists)

**Root cause:** `settingsForm` (line 83) starts as `{}` and accumulates changes. On save, `refetch()` reloads `group.settings`, but `settingsForm` retains its values. The form displays `settingsForm.enabled ?? settings.enabled`, so the old override shadows the fresh data.

**Impact:** Low — the values are actually correct after save (they match what was saved). But it means the form is in a "dirty" state even though no unsaved changes exist, which can confuse users who navigate away and return.

**Fix:** Clear `settingsForm` to `{}` after a successful save:
```typescript
await apiCall('PATCH', ...)
setSettingsForm({})  // Reset form state
refetch()
```

---

### BUG 5: Factory page sets state during render (React anti-pattern)

**File:** `dashboard/client/src/pages/Factory.tsx:254-256`

```typescript
if (initialRuns && !runs) {
  setRuns(initialRuns)
}
```

This `setState` call during render triggers an immediate re-render. React handles it by batching, but it's a React anti-pattern that will log warnings in strict mode. Additionally, WebSocket updates that arrive before `initialRuns` loads are silently dropped (the `onWsEvent` handler checks `if (!prev) return prev`).

**Fix:** Move the initialization to a `useEffect`:
```typescript
useEffect(() => {
  if (initialRuns && !runs) setRuns(initialRuns)
}, [initialRuns])
```

---

## Low

### BUG 6: Mock `listGroups` doesn't return `members` array

**File:** `bot/src/mock/signalServer.ts:152-154`

**Steps to reproduce:** View the Groups page — "Members" column shows "0" for all groups.

**Root cause:** The mock `listGroups` handler returns `{ id, name, isMember }` but not `members`. Real signal-cli returns a `members` array. The `enrichGroups` function in the dashboard expects `members: string[]`.

**Impact:** Cosmetic only in mock mode. Dashboard correctly shows member count when connected to real signal-cli.

**Fix:** Add `members: [SENDER]` to the mock `listGroups` response.

---

### BUG 7: No React error boundary — any render crash blanks the entire app

**File:** `dashboard/client/src/App.tsx`

As demonstrated by BUG 1, a single render error in any page component crashes the entire React tree, leaving a completely blank page with no way to navigate (sidebar disappears too). There's no error boundary to catch and contain the failure.

**Fix:** Add an error boundary wrapping the Routes component:
```tsx
<ErrorBoundary fallback={<div>Something went wrong. <a href="/">Return to Dashboard</a></div>}>
  <Routes>...</Routes>
</ErrorBoundary>
```

---

### BUG 8: `useApi` hook doesn't use `AbortController`

**File:** `dashboard/client/src/hooks/useApi.ts:8-15`

When navigating between pages quickly, the previous page's API fetch may complete after unmount, calling `setData`/`setLoading` on an unmounted component. React 18+ suppresses the warning, but the stale response can still cause unexpected behavior if the component re-mounts before the old fetch completes.

---

## What Works Well

All 10 bugs from the previous testing report (dashboard-testing-report.md) have been fixed:
- Stats cards now show real counts
- Group IDs are properly URL-encoded across all pages
- Dashboard groups table shows message count and last activity
- GroupDetail page shows proper error state (not stuck on "Loading...")
- Factory WebSocket events now bridge to the frontend
- Mock server supports `getGroup`, `quitGroup`, and `joinGroup` handlers
- Messages page uses `null` URL (no wasteful `_none_` calls)
- All mutation operations have try/catch with user-facing alerts
- Dashboard WebSocket events trigger refetches
- Destructive operations have confirmation dialogs

### Pages verified working:
- **Dashboard** — status cards, groups summary table, recurring reminders table, WebSocket connection indicator, real-time refetch on WS events
- **Groups** — list with member count/persona/status, join group form with validation, row click navigation
- **GroupDetail** — Overview tab (status cards, enable/disable, leave group with confirmation), Settings tab (form renders and saves), Dossiers tab, Messages tab
- **Reminders** — one-off and recurring tables, group filter, cancel with confirmation, reset failures
- **Dossiers** — list, edit panel, delete with confirmation, group filter
- **Personas** — create form, edit panel, delete with confirmation, default persona protection
- **Memories** — list, edit panel, delete with confirmation, group filter
- **Messages** — group selector, message table, search
- **Attachments** — stats cards, storage by group table, preview images, delete with confirmation
- **Factory** — run cards with stage bars, diary expand/collapse, live/offline indicator, run count summary
- **Navigation** — all sidebar links route correctly, active state highlighting, SPA fallback for unknown routes

### Security:
- SQL injection: **Safe** — all database queries use parameterized statements. Tested with `'; DROP TABLE messages; --` — returns empty array, no SQL execution.
- XSS: **Safe** — React's JSX escaping prevents script execution. Tested storing `<script>alert(1)</script>` in persona name — rendered as literal text.
- Signal-cli downtime: **Handled** — groups API returns 503, health endpoint shows `signalCliReachable: false`, other pages continue working.
