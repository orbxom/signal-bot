# Outlook Calendar & Email Integration — Design Spec

## Overview

Two new MCP tool servers giving the Signal bot access to a personal Outlook.com account via Microsoft Graph API. The bot can manage calendar events independently (create, view, edit, delete, add attendees) and perform on-demand email triage (summarize inbox, propose actions, archive junk, create calendar events from emails).

## Constraints & Decisions

- **Personal Outlook.com account** — OAuth 2.0 with PKCE, delegated permissions, no admin consent required
- **No email deletion** — archive only
- **No email sending/replying** — out of scope
- **On-demand only** — no scheduled runs; user triggers via Signal message
- **Calendar and email are independent** — calendar tools work standalone, email triage can trigger calendar operations
- **Compact Signal output** — email summaries show subject + sender + one-line summary per email
- **Attendee management** — add attendees to existing events (sends Outlook invites), no Signal-side sharing
- **Token sync** — refresh token stored in `bot/.env`, automatically synced to NUC via deploy script

## Architecture

### Approach: Two Separate MCP Servers + Shared Auth Module

```
bot/src/mcp/servers/
  outlookCalendar.ts    — Calendar CRUD + attendee management (6 tools)
  outlookEmail.ts       — Inbox listing, reading, archiving (4 tools)
  outlook-auth.ts       — Shared auth module (not an MCP server)
```

This follows the existing project convention where each MCP server is a focused, independent unit. The shared auth module is a regular TypeScript import used by both servers.

## Authentication & Token Management

### OAuth App Registration

Register an app in Microsoft Entra (Azure AD) portal for personal accounts. Required Graph API delegated permissions:

- `Calendars.ReadWrite` — create/read/update/delete events, manage attendees
- `Mail.ReadWrite` — read emails, update properties (archive = move to Archive folder)
- `User.Read` — basic profile (required by default)

### Token Flow

1. **One-time setup:** Run `scripts/outlook-auth.ts` on dev PC. Opens browser for login + consent, catches OAuth redirect on a temporary local HTTP server, exchanges authorization code for tokens via PKCE flow (no client secret needed for public clients), prints refresh token for `bot/.env`.
2. **Runtime:** `outlook-auth.ts` reads `OUTLOOK_REFRESH_TOKEN` from env, exchanges for access token on first use, caches in memory, auto-refreshes ~5 minutes before expiry (tokens last 1 hour).
3. **Deploy:** `scripts/deploy-nuc.sh` syncs the refresh token to the NUC's `bot/.env` automatically.

### Shared Auth Module: `bot/src/mcp/servers/outlook-auth.ts`

- `getAccessToken(): Promise<string>` — returns valid access token, refreshing if needed
- `graphFetch(path: string, options?): Promise<Response>` — thin wrapper around `fetch` with `Authorization: Bearer` header and base URL (`https://graph.microsoft.com/v1.0`). Handles 401 retry (force-refresh token, retry once).

### Environment Variables

```
OUTLOOK_REFRESH_TOKEN=M.C105_BAY.0.U.-Cr...
OUTLOOK_CLIENT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

Both optional — if `OUTLOOK_REFRESH_TOKEN` is missing, Outlook tools simply don't initialize. The bot runs fine without them.

## Calendar MCP Server

**File:** `bot/src/mcp/servers/outlookCalendar.ts`
**Config key:** `outlook_calendar`
**Entrypoint:** `outlookCalendar`
**Env mapping:** `{ OUTLOOK_REFRESH_TOKEN: 'outlookRefreshToken', OUTLOOK_CLIENT_ID: 'outlookClientId', TZ: 'timezone' }`

### Tools (6)

#### `list_calendar_events`
- **Inputs:** `startDate` (required, ISO date), `endDate` (optional, defaults to same day)
- **Returns:** Subject, start/end times, location, attendees, online meeting link
- **Graph:** `GET /me/calendarView?startDateTime=...&endDateTime=...`

#### `get_calendar_event`
- **Inputs:** `eventId` (required)
- **Returns:** Full event body, attendees with response status, recurrence info, categories
- **Graph:** `GET /me/events/{id}`

#### `create_calendar_event`
- **Inputs:** `subject` (required), `startDateTime` (required), `endDateTime` (required), `location` (optional), `body` (optional), `isOnlineMeeting` (optional, boolean)
- **Returns:** Created event ID + summary
- **Graph:** `POST /me/events`
- **Notification:** Yes

#### `update_calendar_event`
- **Inputs:** `eventId` (required), plus any of: `subject`, `startDateTime`, `endDateTime`, `location`, `body`
- **Returns:** Updated event summary
- **Graph:** `PATCH /me/events/{id}`
- **Notification:** Yes

#### `delete_calendar_event`
- **Inputs:** `eventId` (required)
- **Returns:** Confirmation
- **Graph:** `DELETE /me/events/{id}`
- **Notification:** Yes

#### `add_event_attendees`
- **Inputs:** `eventId` (required), `attendees` (required, array of email addresses)
- **Behavior:** Reads current attendees, merges new ones, PATCHes the event
- **Returns:** Updated attendee list
- **Graph:** `GET /me/events/{id}` then `PATCH /me/events/{id}`
- **Notification:** Yes

## Email MCP Server

**File:** `bot/src/mcp/servers/outlookEmail.ts`
**Config key:** `outlook_email`
**Entrypoint:** `outlookEmail`
**Env mapping:** `{ OUTLOOK_REFRESH_TOKEN: 'outlookRefreshToken', OUTLOOK_CLIENT_ID: 'outlookClientId', TZ: 'timezone' }`

### Tools (4)

#### `list_emails`
- **Inputs:** `count` (optional, default 25, max 50), `filter` (optional — "unread", "today", or "all", default "unread")
- **Returns:** Compact list — sender, subject, received time, one-line preview, read/unread flag, email ID
- **Graph:** `GET /me/mailFolders/Inbox/messages?$top=...&$select=subject,from,receivedDateTime,bodyPreview,isRead&$orderby=receivedDateTime desc`
- **Filtering:** `$filter=isRead eq false` for "unread", `receivedDateTime ge {today}` for "today"

#### `read_email`
- **Inputs:** `emailId` (required)
- **Returns:** Full body (plain text preferred, stripped HTML fallback), headers, attachment names (no content)
- **Graph:** `GET /me/messages/{id}?$select=subject,from,toRecipients,ccRecipients,body,receivedDateTime,hasAttachments,attachments`

#### `archive_emails`
- **Inputs:** `emailIds` (required, array of email IDs)
- **Behavior:** Moves each email via `POST /me/messages/{id}/move` with `destinationId: "archive"`
- **Returns:** Count of successfully archived emails
- **Notification:** Yes — "Archived 5 emails"

#### `mark_emails_read`
- **Inputs:** `emailIds` (required, array of email IDs)
- **Behavior:** PATCHes each email with `{ isRead: true }`
- **Returns:** Count updated

### Deliberately Excluded

- No delete — per requirement
- No send/reply — not in scope
- No attachment download — preview + names sufficient for triage
- No folder management — archive is the one needed operation

## Email Triage Workflow

When the user says "claude: check my emails", the inner Claude:

1. Calls `list_emails` with filter "unread" (or "today")
2. For anything that looks like it needs a calendar event, calls `list_calendar_events` to check if one already exists
3. Presents a compact summary in Signal: subject + sender + one-line summary + proposed action for each email
4. Waits for user approval/adjustments
5. Executes — `archive_emails` for junk, `create_calendar_event`/`update_calendar_event` for meetings, leaves important ones alone

This workflow is handled entirely by Claude's system prompt instructions — no special code needed. The multi-turn approve/adjust loop uses the bot's existing conversation flow.

## Setup Script

### `scripts/outlook-auth.ts`

Standalone CLI script (`npx tsx scripts/outlook-auth.ts`):

1. Prints a Microsoft login URL with required scopes
2. Starts temporary local HTTP server on `localhost:3333` to catch OAuth redirect
3. User opens URL in browser, logs in, consents
4. Script receives authorization code, exchanges for tokens via PKCE (no client secret)
5. Prints refresh token + `OUTLOOK_CLIENT_ID` with instructions for `bot/.env`

No external dependencies — uses `node:http` and `node:crypto` for PKCE.

## Deploy Integration

### `scripts/deploy-nuc.sh` Updates

After existing rsync step:

1. Read `OUTLOOK_REFRESH_TOKEN` and `OUTLOOK_CLIENT_ID` from local `bot/.env`
2. SSH into NUC, update those values in NUC's `bot/.env` (sed/replace on specific lines, leave rest untouched)
3. If values don't exist in NUC's `.env` yet, append them

The deploy skill documentation should be updated to mention these new env vars.

## Config & Registry Integration

### `bot/src/config.ts` — New Fields

```typescript
outlookRefreshToken: string    // from OUTLOOK_REFRESH_TOKEN, optional (empty = Outlook disabled)
outlookClientId: string        // from OUTLOOK_CLIENT_ID, optional
```

### Registry

No changes to `bot/src/mcp/registry.ts`. The two servers are added to `ALL_SERVERS` in `bot/src/mcp/servers/index.ts` and autodiscovery handles the rest.

### MessageContext Extension

Two new fields: `outlookRefreshToken` and `outlookClientId`. Populated from config in `messageHandler.ts`.

### No Database Changes

Neither server needs database tables. All state lives in Microsoft Graph.

## Testing Strategy

### Auth Module Unit Tests
- Token refresh — mock Graph token endpoint, verify caching, verify auto-refresh before expiry
- `graphFetch` — mock fetch, verify auth header injection, verify 401 retry with fresh token
- Error handling — expired refresh token, network failures, invalid responses

### MCP Server Integration Tests

Following existing pattern (`bot/tests/helpers/mcpTestHelpers.ts`):

**`outlookCalendarMcpServer.test.ts`:**
- Spawn server with test env vars
- Verify `tools/list` returns all 6 tools
- Mock Graph API responses at the network level
- Test each tool with valid inputs + error cases (missing args, 404, etc.)

**`outlookEmailMcpServer.test.ts`:**
- Same spawn pattern
- Verify `tools/list` returns all 4 tools
- Mock Graph responses for inbox listing, reading, archive moves
- Test batch operations with partial failures

### Not Tested
- Actual Microsoft Graph API calls — mock only
- Triage workflow — that's system prompt behavior, not code
- OAuth browser flow in setup script — manual one-time operation

### Mocking Approach
Tests inject mock fetch to return canned Graph API responses, matching the pattern used by weather server tests.

## File Summary

New files:
- `bot/src/mcp/servers/outlook-auth.ts` — shared auth module
- `bot/src/mcp/servers/outlookCalendar.ts` — calendar MCP server
- `bot/src/mcp/servers/outlookEmail.ts` — email MCP server
- `scripts/outlook-auth.ts` — one-time OAuth setup script
- `bot/tests/outlookCalendarMcpServer.test.ts` — calendar server tests
- `bot/tests/outlookEmailMcpServer.test.ts` — email server tests
- `bot/tests/outlook-auth.test.ts` — auth module tests

Modified files:
- `bot/src/mcp/servers/index.ts` — add two imports to `ALL_SERVERS`
- `bot/src/config.ts` — add `outlookRefreshToken` and `outlookClientId` fields
- `bot/src/messageHandler.ts` — populate new `MessageContext` fields from config
- `scripts/deploy-nuc.sh` — add Outlook token sync step
