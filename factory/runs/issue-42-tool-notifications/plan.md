# MCP Tool Signal Notifications with Per-Group Toggle — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add opt-in per-group Signal notifications when MCP tools complete, with a toggle MCP tool and shared notification utility.

**Architecture:** New `tool_notification_settings` DB table (migration v6) with a `ToolNotificationStore`. The registry reads the setting when spawning MCP servers and passes `TOOL_NOTIFICATIONS_ENABLED=1` as an env var (along with `SIGNAL_CLI_URL` and `SIGNAL_ACCOUNT`). A shared `notify.ts` module exports `sendToolNotification()` (reads env vars, fire-and-forget) and `withNotification()` (composes around `catchErrors()` — same semantics, adds notification). A new `settings.ts` MCP server provides the toggle tool. State-changing MCP servers are updated to use `withNotification()`. Read-only servers keep `catchErrors()` unchanged.

**Tech Stack:** TypeScript, better-sqlite3, Vitest, signal-cli JSON-RPC API

---

## Task 1: ToolNotificationStore + Database Migration

**Files:**
- Create: `bot/src/stores/toolNotificationStore.ts`
- Create: `bot/src/__tests__/stores/toolNotificationStore.test.ts`
- Modify: `bot/src/db.ts` (add `migrateToV6`)

### Step 1: Write the failing test

```typescript
// bot/src/__tests__/stores/toolNotificationStore.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseConnection } from '../../db.js';
import { ToolNotificationStore } from '../../stores/toolNotificationStore.js';

describe('ToolNotificationStore', () => {
  let conn: DatabaseConnection;
  let store: ToolNotificationStore;

  beforeEach(() => {
    conn = new DatabaseConnection(':memory:');
    store = new ToolNotificationStore(conn);
  });

  afterEach(() => {
    conn.close();
  });

  it('returns false for unknown group (default off)', () => {
    expect(store.isEnabled('group-1')).toBe(false);
  });

  it('enables notifications for a group', () => {
    store.setEnabled('group-1', true);
    expect(store.isEnabled('group-1')).toBe(true);
  });

  it('disables notifications for a group', () => {
    store.setEnabled('group-1', true);
    store.setEnabled('group-1', false);
    expect(store.isEnabled('group-1')).toBe(false);
  });

  it('isolates settings per group', () => {
    store.setEnabled('group-1', true);
    expect(store.isEnabled('group-1')).toBe(true);
    expect(store.isEnabled('group-2')).toBe(false);
  });

  it('upserts on repeated calls', () => {
    store.setEnabled('group-1', true);
    store.setEnabled('group-1', true);
    expect(store.isEnabled('group-1')).toBe(true);
  });
});
```

### Step 2: Run test to verify it fails

Run: `cd bot && npx vitest run src/__tests__/stores/toolNotificationStore.test.ts`
Expected: FAIL — module not found

### Step 3: Write the migration and store

Add `migrateToV6()` to `bot/src/db.ts`, called after `migrateToV5()` in the migration chain:

```typescript
// Add to bot/src/db.ts — in the migrate() method, after this.migrateToV5():
this.migrateToV6();

// New method:
private migrateToV6(): void {
  const currentVersion = this.getSchemaVersion();
  if (currentVersion < 6) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tool_notification_settings (
        groupId TEXT NOT NULL PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 0,
        updatedAt INTEGER NOT NULL
      );
    `);
    this.setSchemaVersion(6);
  }
}
```

Create the store:

```typescript
// bot/src/stores/toolNotificationStore.ts
import type { DatabaseConnection } from '../db.js';
import { wrapSqliteError } from '../db.js';

export class ToolNotificationStore {
  private getStmt;
  private upsertStmt;

  constructor(private conn: DatabaseConnection) {
    this.getStmt = conn.db.prepare(
      'SELECT enabled FROM tool_notification_settings WHERE groupId = ?'
    );
    this.upsertStmt = conn.db.prepare(`
      INSERT INTO tool_notification_settings (groupId, enabled, updatedAt)
      VALUES (?, ?, ?)
      ON CONFLICT(groupId) DO UPDATE SET
        enabled = excluded.enabled,
        updatedAt = excluded.updatedAt
    `);
  }

  isEnabled(groupId: string): boolean {
    try {
      const row = this.getStmt.get(groupId) as { enabled: number } | undefined;
      return row ? Boolean(row.enabled) : false;
    } catch (err) {
      throw wrapSqliteError(err, 'isEnabled');
    }
  }

  setEnabled(groupId: string, enabled: boolean): void {
    try {
      this.upsertStmt.run(groupId, enabled ? 1 : 0, Date.now());
    } catch (err) {
      throw wrapSqliteError(err, 'setEnabled');
    }
  }
}
```

### Step 4: Run test to verify it passes

Run: `cd bot && npx vitest run src/__tests__/stores/toolNotificationStore.test.ts`
Expected: PASS (all 5 tests)

### Step 5: Commit

```bash
git add bot/src/stores/toolNotificationStore.ts bot/src/__tests__/stores/toolNotificationStore.test.ts bot/src/db.ts
git commit -m "feat: add tool notification settings store and migration v6"
```

---

## Task 2: Shared Notification Utility

The notification utility reads `TOOL_NOTIFICATIONS_ENABLED` from env (set by the registry at process spawn time). No DB access needed in this module — the registry handles that. This eliminates cache staleness issues and migration edge cases.

**Files:**
- Create: `bot/src/mcp/notify.ts`
- Create: `bot/src/__tests__/mcp/notify.test.ts`

### Step 1: Write the failing test

```typescript
// bot/src/__tests__/mcp/notify.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockFetch = vi.fn().mockResolvedValue({ ok: true });
vi.stubGlobal('fetch', mockFetch);

const { sendToolNotification, withNotification } = await import('../../mcp/notify.js');
const { ok, error } = await import('../../mcp/result.js');

describe('sendToolNotification', () => {
  beforeEach(() => {
    mockFetch.mockClear();
    process.env.SIGNAL_CLI_URL = 'http://localhost:9090';
    process.env.SIGNAL_ACCOUNT = '+61400000000';
    process.env.MCP_GROUP_ID = 'test-group-123';
    process.env.TOOL_NOTIFICATIONS_ENABLED = '1';
  });

  afterEach(() => {
    delete process.env.SIGNAL_CLI_URL;
    delete process.env.SIGNAL_ACCOUNT;
    delete process.env.MCP_GROUP_ID;
    delete process.env.TOOL_NOTIFICATIONS_ENABLED;
  });

  it('sends message when notifications are enabled', async () => {
    await sendToolNotification('Reminder set for 3pm');
    expect(mockFetch).toHaveBeenCalledOnce();
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.method).toBe('send');
    expect(body.params.message).toContain('Reminder set for 3pm');
    expect(body.params.groupId).toBe('test-group-123');
  });

  it('prefixes success messages with Done', async () => {
    await sendToolNotification('Reminder set');
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.params.message).toMatch(/^Done/);
  });

  it('prefixes failure messages with Failed', async () => {
    await sendToolNotification('Could not set reminder', false);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.params.message).toMatch(/^Failed/);
  });

  it('does not send when TOOL_NOTIFICATIONS_ENABLED is not set', async () => {
    delete process.env.TOOL_NOTIFICATIONS_ENABLED;
    await sendToolNotification('Test');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does not send when TOOL_NOTIFICATIONS_ENABLED is 0', async () => {
    process.env.TOOL_NOTIFICATIONS_ENABLED = '0';
    await sendToolNotification('Test');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does not send when SIGNAL_CLI_URL is missing', async () => {
    delete process.env.SIGNAL_CLI_URL;
    await sendToolNotification('Test');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('silently handles fetch errors', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Connection refused'));
    await sendToolNotification('Test');
    // Should not throw
  });
});

describe('withNotification', () => {
  beforeEach(() => {
    mockFetch.mockClear();
    process.env.SIGNAL_CLI_URL = 'http://localhost:9090';
    process.env.SIGNAL_ACCOUNT = '+61400000000';
    process.env.MCP_GROUP_ID = 'test-group-123';
    process.env.TOOL_NOTIFICATIONS_ENABLED = '1';
  });

  afterEach(() => {
    delete process.env.SIGNAL_CLI_URL;
    delete process.env.SIGNAL_ACCOUNT;
    delete process.env.MCP_GROUP_ID;
    delete process.env.TOOL_NOTIFICATIONS_ENABLED;
  });

  it('sends success notification and returns result on success', async () => {
    const result = await withNotification(
      'Item created',
      'Failed to create item',
      () => ok('Created successfully'),
    );
    expect(result.isError).toBeFalsy();
    expect(mockFetch).toHaveBeenCalledOnce();
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.params.message).toContain('Item created');
  });

  it('sends error notification when handler throws', async () => {
    const result = await withNotification(
      'Item created',
      'Failed to create item',
      () => { throw new Error('DB locked'); },
    );
    expect(result.isError).toBe(true);
    expect(mockFetch).toHaveBeenCalledOnce();
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.params.message).toContain('Failed');
    expect(body.params.message).toContain('DB locked');
  });

  it('sends error notification when handler returns error result', async () => {
    const result = await withNotification(
      'Item created',
      'Failed to create item',
      () => error('Validation failed'),
    );
    expect(result.isError).toBe(true);
    expect(mockFetch).toHaveBeenCalledOnce();
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.params.message).toContain('Failed');
  });

  it('supports callback for dynamic success messages', async () => {
    const result = await withNotification(
      (r) => {
        const text = r.content[0] && 'text' in r.content[0] ? r.content[0].text : '';
        return text;
      },
      'Failed',
      () => ok('Reminder #42 set for 3pm'),
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.params.message).toContain('Reminder #42 set for 3pm');
  });

  it('preserves catchErrors error prefix in returned result', async () => {
    const result = await withNotification(
      'Done',
      'Failed to create',
      () => { throw new Error('oops'); },
      'create_item',
    );
    expect(result.isError).toBe(true);
    const text = result.content[0] && 'text' in result.content[0] ? result.content[0].text : '';
    expect(text).toContain('create_item');
  });

  it('does not notify when notifications disabled', async () => {
    delete process.env.TOOL_NOTIFICATIONS_ENABLED;
    await withNotification('Done', 'Failed', () => ok('test'));
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
```

### Step 2: Run test to verify it fails

Run: `cd bot && npx vitest run src/__tests__/mcp/notify.test.ts`
Expected: FAIL — module not found

### Step 3: Write the notification utility

```typescript
// bot/src/mcp/notify.ts
import { catchErrors, getErrorMessage } from './result.js';
import type { ToolResult } from './types.js';

/**
 * Send a tool notification to the Signal group. Fire-and-forget.
 * Reads TOOL_NOTIFICATIONS_ENABLED, SIGNAL_CLI_URL, SIGNAL_ACCOUNT,
 * and MCP_GROUP_ID from env vars (set by the registry).
 */
export async function sendToolNotification(message: string, success = true): Promise<void> {
  try {
    if (process.env.TOOL_NOTIFICATIONS_ENABLED !== '1') return;

    const { SIGNAL_CLI_URL, SIGNAL_ACCOUNT, MCP_GROUP_ID } = process.env;
    if (!SIGNAL_CLI_URL || !SIGNAL_ACCOUNT || !MCP_GROUP_ID) return;

    const prefix = success ? 'Done' : 'Failed';
    await fetch(`${SIGNAL_CLI_URL}/api/v1/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'send',
        params: {
          account: SIGNAL_ACCOUNT,
          groupId: MCP_GROUP_ID,
          message: `${prefix} — ${message}`,
        },
        id: `notify-${Date.now()}`,
      }),
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    // Silent — notifications are best-effort
  }
}

/**
 * Wraps catchErrors() and adds tool notifications.
 * On success: sends onSuccess message. On error: sends onError + error details.
 * Preserves catchErrors semantics exactly — same result, same error prefix behavior.
 *
 * @param onSuccess - Static string or callback receiving the successful ToolResult
 * @param onError - Error description prefix for the notification
 * @param fn - The handler function (same as catchErrors)
 * @param errorPrefix - Optional error prefix passed to catchErrors
 */
export async function withNotification(
  onSuccess: string | ((result: ToolResult) => string),
  onError: string,
  fn: () => ToolResult | Promise<ToolResult>,
  errorPrefix?: string,
): Promise<ToolResult> {
  const result = await catchErrors(fn, errorPrefix);

  if (result.isError) {
    const errText =
      result.content[0] && 'text' in result.content[0] ? result.content[0].text : 'unknown error';
    sendToolNotification(`${onError}: ${errText}`, false);
  } else {
    const msg = typeof onSuccess === 'function' ? onSuccess(result) : onSuccess;
    sendToolNotification(msg);
  }

  return result;
}
```

### Step 4: Run test to verify it passes

Run: `cd bot && npx vitest run src/__tests__/mcp/notify.test.ts`
Expected: PASS (all 13 tests)

### Step 5: Commit

```bash
git add bot/src/mcp/notify.ts bot/src/__tests__/mcp/notify.test.ts
git commit -m "feat: add shared tool notification utility"
```

---

## Task 3: Registry Update — Pass Notification Env Vars

The registry reads the notification setting from the DB when building MCP config and passes it as an env var to all servers. This means MCP servers don't need to open their own DB connections for the setting.

**Files:**
- Modify: `bot/src/mcp/registry.ts` (add notification env vars to all servers)
- Modify: caller of `buildMcpConfig()` (pass `toolNotificationsEnabled`)
- Modify: `bot/src/storage.ts` (add ToolNotificationStore to facade, if Storage is used by the caller)

### Step 1: Read `registry.ts`, `claudeClient.ts`, `storage.ts`, and `index.ts`

Understand how `buildMcpConfig()` is called, what parameters it takes, and where `MessageContext` comes from. Also understand how the `Storage` facade works.

### Step 2: Add ToolNotificationStore to Storage facade

If the composition root uses `Storage` to access stores, add the `ToolNotificationStore`:

```typescript
// In bot/src/storage.ts — add:
import { ToolNotificationStore } from './stores/toolNotificationStore.js';

// In the Storage class:
toolNotifications: ToolNotificationStore;

// In the constructor:
this.toolNotifications = new ToolNotificationStore(conn);
```

### Step 3: Update `buildMcpConfig()` to accept and pass notification env vars

In `bot/src/mcp/registry.ts`, modify `buildMcpConfig()` to add common notification env vars to every server's environment:

```typescript
// Add parameter:
export function buildMcpConfig(
  context: MessageContext,
  options?: { toolNotificationsEnabled?: boolean },
): McpConfig {
  // ... existing code ...
  // For each server, add to env:
  env: {
    ...mappedEnvs,
    SIGNAL_CLI_URL: context.signalCliUrl,
    SIGNAL_ACCOUNT: context.botPhoneNumber,
    TOOL_NOTIFICATIONS_ENABLED: options?.toolNotificationsEnabled ? '1' : '0',
  },
}
```

### Step 4: Update the caller to read the setting and pass it

In whatever file calls `buildMcpConfig()` (likely `claudeClient.ts` or `messageHandler.ts`):

```typescript
const toolNotificationsEnabled = storage.toolNotifications.isEnabled(groupId);
const mcpConfig = buildMcpConfig(context, { toolNotificationsEnabled });
```

### Step 5: Write test and verify

Add a test that `buildMcpConfig()` includes `TOOL_NOTIFICATIONS_ENABLED` in server env vars.

Run: `cd bot && npx vitest run`
Expected: All tests pass

### Step 6: Commit

```bash
git add bot/src/mcp/registry.ts bot/src/storage.ts [caller file]
git commit -m "feat: pass tool notification setting as env var to MCP servers"
```

---

## Task 4: Settings MCP Server

**Files:**
- Create: `bot/src/mcp/servers/settings.ts`
- Create: `bot/src/__tests__/mcp/servers/settings.test.ts`
- Modify: `bot/src/mcp/servers/index.ts` (add import)

### Step 1: Write the failing test

The test must call `onInit()` and share the same DB instance (use a temp file, not `:memory:`):

```typescript
// bot/src/__tests__/mcp/servers/settings.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { unlinkSync } from 'fs';

// Import the server definition
import { settingsServer } from '../../../mcp/servers/settings.js';

const TEST_DB = `/tmp/test-settings-${process.pid}.db`;

describe('settings MCP server', () => {
  beforeEach(() => {
    process.env.DB_PATH = TEST_DB;
    process.env.MCP_GROUP_ID = 'test-group-1';
    // Call onInit so the server creates its DB connection and store
    settingsServer.onInit?.();
  });

  afterEach(() => {
    settingsServer.onClose?.();
    delete process.env.DB_PATH;
    delete process.env.MCP_GROUP_ID;
    try { unlinkSync(TEST_DB); } catch {}
    try { unlinkSync(TEST_DB + '-wal'); } catch {}
    try { unlinkSync(TEST_DB + '-shm'); } catch {}
  });

  describe('toggle_tool_notifications', () => {
    it('enables notifications for a group', async () => {
      const result = await settingsServer.handlers.toggle_tool_notifications({
        group_id: 'test-group-1',
        enabled: true,
      });
      expect(result.isError).toBeFalsy();
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain('enabled');
    });

    it('disables notifications for a group', async () => {
      await settingsServer.handlers.toggle_tool_notifications({
        group_id: 'test-group-1',
        enabled: true,
      });
      const result = await settingsServer.handlers.toggle_tool_notifications({
        group_id: 'test-group-1',
        enabled: false,
      });
      expect(result.isError).toBeFalsy();
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain('disabled');
    });

    it('handles string "true" for enabled parameter', async () => {
      const result = await settingsServer.handlers.toggle_tool_notifications({
        group_id: 'test-group-1',
        enabled: 'true',
      });
      expect(result.isError).toBeFalsy();
    });

    it('requires group_id parameter', async () => {
      const result = await settingsServer.handlers.toggle_tool_notifications({
        enabled: true,
      });
      expect(result.isError).toBe(true);
    });
  });

  describe('get_tool_notification_status', () => {
    it('returns disabled by default', async () => {
      const result = await settingsServer.handlers.get_tool_notification_status({
        group_id: 'test-group-1',
      });
      expect(result.isError).toBeFalsy();
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain('disabled');
    });

    it('returns enabled after toggle', async () => {
      await settingsServer.handlers.toggle_tool_notifications({
        group_id: 'test-group-1',
        enabled: true,
      });
      const result = await settingsServer.handlers.get_tool_notification_status({
        group_id: 'test-group-1',
      });
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain('enabled');
    });
  });
});
```

### Step 2: Run test to verify it fails

Run: `cd bot && npx vitest run src/__tests__/mcp/servers/settings.test.ts`
Expected: FAIL — module not found

### Step 3: Write the settings server

```typescript
// bot/src/mcp/servers/settings.ts
import { DatabaseConnection } from '../../db.js';
import { ToolNotificationStore } from '../../stores/toolNotificationStore.js';
import { ok, catchErrors } from '../result.js';
import { requireString } from '../validate.js';
import { readStorageEnv } from '../env.js';
import type { McpServerDefinition } from '../types.js';

let conn: DatabaseConnection;
let store: ToolNotificationStore;

export const settingsServer: McpServerDefinition = {
  serverName: 'signal-bot-settings',
  configKey: 'settings',
  entrypoint: 'settings',
  envMapping: {
    DB_PATH: 'dbPath',
    MCP_GROUP_ID: 'groupId',
  },
  tools: [
    {
      name: 'toggle_tool_notifications',
      title: 'Toggle Tool Notifications',
      description:
        'Enable or disable Signal notifications when MCP tools complete. When enabled, tools send a brief confirmation message to the group after completing their action. The change takes effect on the next message (not mid-conversation).',
      inputSchema: {
        type: 'object',
        properties: {
          group_id: {
            type: 'string',
            description: 'The group ID to toggle notifications for. Use the current group ID.',
          },
          enabled: {
            type: 'boolean',
            description: 'true to enable notifications, false to disable.',
          },
        },
        required: ['group_id', 'enabled'],
      },
    },
    {
      name: 'get_tool_notification_status',
      title: 'Get Tool Notification Status',
      description: 'Check whether tool notifications are currently enabled for a group.',
      inputSchema: {
        type: 'object',
        properties: {
          group_id: {
            type: 'string',
            description: 'The group ID to check.',
          },
        },
        required: ['group_id'],
      },
    },
  ],
  handlers: {
    toggle_tool_notifications: (args) =>
      catchErrors(() => {
        const groupId = requireString(args, 'group_id');
        const enabled = args.enabled === true || args.enabled === 'true';
        store.setEnabled(groupId, enabled);
        return ok(
          `Tool notifications ${enabled ? 'enabled' : 'disabled'} for this group.`
        );
      }),
    get_tool_notification_status: (args) =>
      catchErrors(() => {
        const groupId = requireString(args, 'group_id');
        const enabled = store.isEnabled(groupId);
        return ok(
          `Tool notifications are currently ${enabled ? 'enabled' : 'disabled'} for this group.`
        );
      }),
  },
  onInit: () => {
    const dbPath = readStorageEnv();
    conn = new DatabaseConnection(dbPath);
    store = new ToolNotificationStore(conn);
  },
  onClose: () => {
    conn?.close();
  },
};
```

Register in barrel — add to `bot/src/mcp/servers/index.ts`:

```typescript
import { settingsServer } from './settings.js';
// Add settingsServer to ALL_SERVERS array
```

### Step 4: Run test to verify it passes

Run: `cd bot && npx vitest run src/__tests__/mcp/servers/settings.test.ts`
Expected: PASS (all 5 tests)

### Step 5: Commit

```bash
git add bot/src/mcp/servers/settings.ts bot/src/__tests__/mcp/servers/settings.test.ts bot/src/mcp/servers/index.ts
git commit -m "feat: add settings MCP server with tool notification toggle"
```

---

## Task 5: Update State-Changing MCP Servers with Notifications

Only state-changing servers get notifications. Read-only servers (weather, sourceCode, messageHistory, images) keep `catchErrors` unchanged — notifying "Weather forecast retrieved" is noise for a family group chat.

**Files to modify** (replace `catchErrors` with `withNotification` in state-changing handlers):

- `bot/src/mcp/servers/reminders.ts` — set_reminder, cancel_reminder, set_recurring_reminder, cancel_recurring_reminder (list operations are read-only, keep `catchErrors`)
- `bot/src/mcp/servers/dossiers.ts` — all 3 tools (save/update/delete are state-changing)
- `bot/src/mcp/servers/personas.ts` — create, update, delete, switch_persona (list is read-only)
- `bot/src/mcp/servers/github.ts` — create_feature_request, comment_on_pr, submit_review, merge_pr (list/view/diff are read-only)
- `bot/src/mcp/servers/memories.ts` — save_memory, delete_memory (search is read-only)
- `bot/src/mcp/servers/darkFactory.ts` — refactor: remove inline `sendSignalNotification()`, use `withNotification`

**NOT modified:**
- `bot/src/mcp/servers/signal.ts` — excluded (send_message/send_image ARE the notification)
- `bot/src/mcp/servers/settings.ts` — excluded (avoid loops)
- `bot/src/mcp/servers/weather.ts` — read-only
- `bot/src/mcp/servers/sourceCode.ts` — read-only
- `bot/src/mcp/servers/messageHistory.ts` — read-only
- `bot/src/mcp/servers/images.ts` — read-only

### Pattern for each server

**1. Import `withNotification`:**
```typescript
import { withNotification } from '../notify.js';
```

**2. Replace `catchErrors` with `withNotification` in state-changing handlers only:**

Before:
```typescript
set_reminder: (args) => catchErrors(async () => {
  const time = requireString(args, 'time');
  // ... create reminder
  return ok(`Reminder set for ${time}`);
}, 'set_reminder'),
```

After:
```typescript
set_reminder: (args) => withNotification(
  'Reminder set',       // or use callback: (r) => extractFirstLine(r)
  'set reminder',       // error context
  async () => {
    const time = requireString(args, 'time');
    // ... create reminder (same body as before)
    return ok(`Reminder set for ${time}`);
  },
  'set_reminder',       // error prefix for catchErrors (preserve existing behavior)
),
```

**For dynamic success messages** (where the notification needs info computed by the handler), use a callback:

```typescript
set_reminder: (args) => withNotification(
  (result) => {
    const text = result.content[0] && 'text' in result.content[0] ? result.content[0].text : '';
    return text.split('\n')[0]; // First line as notification
  },
  'set reminder',
  async () => { ... },
  'set_reminder',
),
```

**3. Special case — darkFactory.ts:**
- Remove the inline `sendSignalNotification()` function
- Remove the module-level `signalCliUrl`, `signalAccount`, `groupId` variables used only for that function
- Replace with `import { withNotification } from '../notify.js'` on the start_dark_factory handler

### Step 1: Update all state-changing servers

Apply the pattern above. For each state-changing handler:
- Choose a concise success message (or use a callback for dynamic messages)
- Choose an error context string
- Preserve the existing `catchErrors` error prefix if one exists
- Keep `catchErrors` for read-only handlers in the same server

### Step 2: Run the full test suite

Run: `cd bot && npx vitest run`
Expected: All existing tests pass. `withNotification` wraps `catchErrors` — same result returned, same error prefix behavior.

### Step 3: Run lint and check

Run: `cd bot && npm run lint && npm run check`
Expected: PASS

### Step 4: Commit

```bash
git add bot/src/mcp/servers/
git commit -m "feat: add tool notifications to state-changing MCP servers"
```

---

## Task 6: Update creating-mcp-tools Skill

**Files:**
- Modify: `.claude/skills/creating-mcp-tools/SKILL.md`

### Step 1: Add notification integration section

Add a new section after the existing "Step 5: Register in barrel export":

```markdown
### Integrating Tool Notifications

MCP tools can send brief Signal notifications to the group after completing state-changing actions. This is opt-in per group — controlled by the `toggle_tool_notifications` tool in the settings server.

**How it works:** The registry passes `TOOL_NOTIFICATIONS_ENABLED=1`, `SIGNAL_CLI_URL`, and `SIGNAL_ACCOUNT` as env vars to all MCP servers. The `withNotification()` wrapper composes around `catchErrors()` to send a Signal notification after the tool completes.

**To add notifications to state-changing handlers:**

1. Import `withNotification`:
   ```typescript
   import { withNotification } from '../notify.js';
   ```

2. Replace `catchErrors` with `withNotification` for state-changing handlers:
   ```typescript
   my_tool: (args) => withNotification(
     'Item created',              // success notification (or callback for dynamic messages)
     'create item',               // error context for notification
     () => {
       const name = requireString(args, 'name');
       // ... your implementation
       return ok(`Created ${name}`);
     },
     'my_tool',                   // error prefix for catchErrors (optional)
   ),
   ```

3. For dynamic success messages, use a callback:
   ```typescript
   onSuccess: (result) => {
     const text = result.content[0] && 'text' in result.content[0] ? result.content[0].text : '';
     return text.split('\n')[0];
   },
   ```

**Do NOT add notifications to:**
- Read-only tools (search, list, view, etc.) — keep using `catchErrors`
- The `send_message` / `send_image` tools (the message IS the notification)
- The `toggle_tool_notifications` tool (avoid infinite loops)

**Notification messages should be:**
- Concise (1 line, describes what happened)
- User-facing (no internal IDs or raw data)
- Prefixed automatically with "Done" or "Failed" by the utility
```

### Step 2: Update Key File References table

Add:
| File | Purpose |
|------|---------|
| `bot/src/mcp/notify.ts` | Shared notification utility: `sendToolNotification()`, `withNotification()` |
| `bot/src/stores/toolNotificationStore.ts` | Per-group notification toggle setting store |
| `bot/src/mcp/servers/settings.ts` | Settings MCP server with toggle tool |

### Step 3: Commit

```bash
git add .claude/skills/creating-mcp-tools/SKILL.md
git commit -m "docs: update creating-mcp-tools skill with notification integration guide"
```

---

## Summary

| Task | What | New Files | Modified Files |
|------|------|-----------|---------------|
| 1 | Store + migration | `stores/toolNotificationStore.ts`, test | `db.ts` |
| 2 | Notification utility | `mcp/notify.ts`, test | — |
| 3 | Registry update | — | `registry.ts`, `storage.ts`, caller of buildMcpConfig |
| 4 | Settings MCP server | `mcp/servers/settings.ts`, test | `mcp/servers/index.ts` |
| 5 | Update state-changing servers | — | 6 server files |
| 6 | Update skill docs | — | `creating-mcp-tools/SKILL.md` |

**Dependencies:** Task 1 before Tasks 2, 3, 4. Task 2 before Task 5. Task 3 before Task 5 (servers need the env var). Tasks 4, 5, 6 are independent of each other once Tasks 1-3 are done.

**Parallelizable:** Tasks 4, 5, and 6 can be done in parallel after Tasks 1, 2, and 3.

---

## Revisions

Changes from the initial plan based on devil's advocate review:

### Addressed Concerns

1. **`withNotification` now composes around `catchErrors` instead of replacing it.** (Critical #1) The initial plan had `withNotification` as a drop-in replacement with subtly different semantics (always async, lost error prefix). Now `withNotification` calls `catchErrors` internally and adds notification after — identical result returned, identical error prefix behavior. No behavioral regression risk.

2. **Added `memories.ts` server.** (Critical #2) Was missing from the initial plan despite being a state-changing server with save/delete operations.

3. **Success message supports callbacks for dynamic content.** (Critical #3) `onSuccess` parameter now accepts `string | ((result: ToolResult) => string)`, allowing notifications to include handler-computed values like IDs.

4. **Only state-changing tools get notifications.** (Important #4) Read-only tools (weather, sourceCode, messageHistory, images, and list/view operations of other servers) keep `catchErrors` unchanged. "Weather forecast retrieved" notifications are noise in a family chat.

5. **Notification setting passed as env var from registry.** (Important #5) Eliminates the separate raw DB connection in `notify.ts`, the migration edge case (table might not exist), the process-lifetime cache staleness issue, and the test-only `resetNotificationCache` export. The registry reads the setting once when spawning MCP servers.

6. **Changed prefix from `[tool]` to `Done/Failed`.** (Important #6) "Done — Reminder set for 3pm" is human-friendly for a family group chat. "Failed — Could not set reminder" is immediately understandable.

7. **Fixed settings server tests.** (Important #7) Tests now use temp file DB (not `:memory:` which creates separate DBs), call `onInit()` in beforeEach, and call `onClose()` in afterEach.

8. **Mid-conversation cache staleness acknowledged.** (Important #8) Solved by the env var approach — setting is read at process spawn time. Explicitly noted in the toggle tool description: "The change takes effect on the next message."

### Dismissed Concerns

- **#9 Boolean parameter:** The handler already coerces string "true". LLMs handle booleans fine in tool schemas. Not worth adding enum complexity.
- **#13 Fire-and-forget ordering:** Intentional design choice. Notification is best-effort; not worth awaiting.
- **#14 Rate limiting:** YAGNI. With only state-changing tools notifying, volume is naturally low. Can add later if needed.
- **#15 Test-only export:** Eliminated by the env var approach — no cache, no `resetNotificationCache`.
