# Dashboard Join Group via Invite Link

## Problem

There's no way to add the bot to a new Signal group from the dashboard. Currently, group joining must happen outside the dashboard, and the bot can only interact with groups it's already a member of.

## Solution

Add an input field + "Join" button at the top of the Groups page. User pastes a Signal group invite link, the bot joins via signal-cli, and the group appears in the list with default settings.

## Feasibility

signal-cli's JSON-RPC docs state: "The commands available for the JSON-RPC mode are the same as the cli commands (except `register`, `verify` and `link`)." The CLI supports `joinGroup --uri <link>`, and `joinGroup` is not in the excluded list, so it is available via JSON-RPC.

**RPC call:**
```json
{ "method": "joinGroup", "params": { "uri": "https://signal.group/#..." } }
```

The `joinGroup` RPC method likely returns void/empty (like `quitGroup`). After joining, a follow-up `listGroups()` call is needed to find the newly joined group and return its info to the UI.

## Components

### 1. Signal Client — `joinGroup(uri)` method

New method in `bot/src/signalClient.ts`. Calls signal-cli's `joinGroup` JSON-RPC method with `{ uri }` parameter. Returns void. Throws on failure (invalid link, expired link, signal-cli error).

### 2. Dashboard API — `POST /api/groups/join`

New endpoint in `dashboard/src/routes/groups.ts`. Accepts `{ uri: string }`.

Flow:
1. Validate `uri` starts with `https://signal.group/` — return `400` if not
2. Call `signalClient.joinGroup(uri)` — return `503` if signal-cli unreachable
3. Call `signalClient.listGroups()` to find the newly joined group
4. Return the group info (matching existing `GET /api/groups/:id` shape)
5. On signal-cli error (invalid/expired link): return `422` with error message

### 3. Dashboard UI — Input on Groups page

Text input + "Join" button at the top of `Groups.tsx`, above the group list. On submit:

- Calls `POST /api/groups/join` with `{ uri }`
- Shows loading state (button disabled, spinner)
- On success: refreshes the group list; new group appears with default settings (enabled, global triggers). Input is cleared.
- On failure: shows inline error message below the input. Error clears on next submit attempt.

User configures the group (triggers, persona, context window) via the existing GroupDetail page after joining.

## Data Flow

```
Paste link → Click Join → POST /api/groups/join
→ validate uri format → signalClient.joinGroup(uri) → signalClient.listGroups()
→ return group info → UI refreshes group list → User configures via GroupDetail
```

## Error Handling

- Malformed link (not `https://signal.group/...`): `400` — "Invalid Signal group invite link format"
- Invalid/expired link: `422` — surface signal-cli's error message
- signal-cli not reachable: `503` — "Signal service unavailable"
- Already a member: surface whatever signal-cli returns (likely a no-op or error)

## Known Limitation

Signal groups can require admin approval for members joining via invite link. In this case, `joinGroup` may succeed (request sent) but the bot won't appear in `listGroups` until approved. The API should handle this gracefully — if the group isn't found in `listGroups` after joining, return a `202` with a message like "Join request sent — awaiting admin approval."

## Testing

- Unit test for `SignalClient.joinGroup()` (follows existing pattern in `signalClient.test.ts`)
- Route test for `POST /api/groups/join` — success, invalid format, expired link, signal-cli down, admin-approval cases (follows pattern in `dashboard/tests/routes/groups.test.ts`)

## Out of Scope

- Onboarding wizard or guided setup flow
- Automatic trigger/persona configuration — uses defaults
