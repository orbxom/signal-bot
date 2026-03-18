# Dashboard Join Group via Invite Link

## Problem

There's no way to add the bot to a new Signal group from the dashboard. Currently, group joining must happen outside the dashboard, and the bot can only interact with groups it's already a member of.

## Solution

Add an input field + "Join" button at the top of the Groups page. User pastes a Signal group invite link, the bot joins via signal-cli, and the group appears in the list with default settings.

## Components

### 1. Signal Client — `joinGroup(link)` method

New method in `bot/src/signalClient.ts`. Calls signal-cli's `joinGroup` JSON-RPC endpoint with the invite link URL. Returns group info on success, throws on failure.

### 2. Dashboard API — `POST /api/groups/join`

New endpoint in `dashboard/src/routes/groups.ts`. Accepts `{ link: string }`, calls `signalClient.joinGroup(link)`, returns the joined group's info. Returns appropriate HTTP error if the link is invalid/expired or signal-cli is unreachable.

### 3. Dashboard UI — Input on Groups page

Text input + "Join" button at the top of `Groups.tsx`, above the group list. On submit:

- Calls `POST /api/groups/join` with the pasted link
- Shows loading state on the button
- On success: refreshes the group list; new group appears with default settings (enabled, global triggers)
- On failure: shows inline error message below the input

User configures the group (triggers, persona, context window) via the existing GroupDetail page after joining.

## Data Flow

```
Paste link → Click Join → POST /api/groups/join
→ signalClient.joinGroup(link) → signal-cli JSON-RPC
→ Group appears in list → User configures via existing GroupDetail page
```

## Error Handling

- Invalid/expired link: inline error message below the input with the reason from signal-cli
- signal-cli not reachable: same pattern, surface the error
- Already a member: surface whatever signal-cli returns

## Out of Scope

- Onboarding wizard or guided setup flow
- Link validation before submitting
- Automatic trigger/persona configuration — uses defaults
