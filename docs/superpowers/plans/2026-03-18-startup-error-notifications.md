# Startup & Error Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send a Signal message to the Bot Test channel when the bot starts up (with commit hash) and when it crashes from an unhandled error.

**Architecture:** Two helper functions in a new `notifications.ts` module — `sendStartupNotification` and `sendErrorNotification` — imported and wired into `index.ts`'s startup sequence and error handlers. A `VERSION` file written by the deploy script provides the commit hash. Gated by `STARTUP_NOTIFY` env var.

**Tech Stack:** TypeScript, Node.js fs/path, vitest

**Spec:** `docs/superpowers/specs/2026-03-18-startup-error-notifications-design.md`

---

### Task 1: Add `startupNotify` config flag

**Files:**
- Modify: `bot/src/config.ts:4-28` (ConfigType interface) and `bot/src/config.ts:89-113` (Config.load return)
- Test: `bot/tests/config.test.ts`

- [ ] **Step 1: Write the failing tests**

Add two tests to the existing `describe('Config')` block in `bot/tests/config.test.ts`:

```typescript
it('should default startupNotify to false', () => {
  process.env.BOT_PHONE_NUMBER = '+1234567890';

  const config = Config.load();
  expect(config.startupNotify).toBe(false);
});

it('should set startupNotify to true when STARTUP_NOTIFY is set', () => {
  process.env.BOT_PHONE_NUMBER = '+1234567890';
  process.env.STARTUP_NOTIFY = 'true';

  const config = Config.load();
  expect(config.startupNotify).toBe(true);
});
```

Also add `delete process.env.STARTUP_NOTIFY;` to the `beforeEach` block alongside the other env var cleanup.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd bot && npx vitest run tests/config.test.ts`
Expected: FAIL — `config.startupNotify` is undefined

- [ ] **Step 3: Add `startupNotify` to ConfigType and Config.load()**

In `bot/src/config.ts`, add `startupNotify: boolean;` to the `ConfigType` interface (after `collaborativeTestingMode`).

In the `Config.load()` return object, add:
```typescript
startupNotify: process.env.STARTUP_NOTIFY === 'true',
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd bot && npx vitest run tests/config.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add bot/src/config.ts bot/tests/config.test.ts
git commit -m "feat: add startupNotify config flag"
```

---

### Task 2: Implement `sendStartupNotification` and `sendErrorNotification`

These are standalone async functions in a new `notifications.ts` module. They take a signal client and config, send a message to the test group, and are pure send-and-forget. They live in their own module because `index.ts` has a top-level `main()` call that would execute on import in tests.

**Files:**
- Create: `bot/src/notifications.ts`
- Create: `bot/tests/notifications.test.ts`

- [ ] **Step 1: Write the failing tests for `sendStartupNotification`**

Create `bot/tests/notifications.test.ts`. These tests import the functions from the new `notifications.ts` module. Mock `fs.readFileSync` for VERSION file reads.

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';

vi.mock('../src/logger', () => ({
  logger: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    compact: vi.fn(),
    close: vi.fn(),
  },
}));

import { sendStartupNotification, sendErrorNotification } from '../src/notifications';

describe('sendStartupNotification', () => {
  const mockSignalClient = {
    sendMessage: vi.fn().mockResolvedValue(undefined),
  };

  const baseConfig = {
    startupNotify: true,
    testGroupId: 'test-group-123',
    timezone: 'Australia/Sydney',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should send startup message with commit hash from VERSION file', async () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue('abc1234\n');

    await sendStartupNotification(mockSignalClient as any, baseConfig);

    expect(mockSignalClient.sendMessage).toHaveBeenCalledOnce();
    const msg = mockSignalClient.sendMessage.mock.calls[0][1];
    expect(msg).toContain('Bot online');
    expect(msg).toContain('abc1234');
    expect(mockSignalClient.sendMessage.mock.calls[0][0]).toBe('test-group-123');
  });

  it('should use "unknown" when VERSION file is missing', async () => {
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw new Error('ENOENT');
    });

    await sendStartupNotification(mockSignalClient as any, baseConfig);

    const msg = mockSignalClient.sendMessage.mock.calls[0][1];
    expect(msg).toContain('unknown');
  });

  it('should not send when startupNotify is false', async () => {
    await sendStartupNotification(mockSignalClient as any, {
      ...baseConfig,
      startupNotify: false,
    });

    expect(mockSignalClient.sendMessage).not.toHaveBeenCalled();
  });

  it('should not throw if sendMessage fails', async () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue('abc1234\n');
    mockSignalClient.sendMessage.mockRejectedValueOnce(new Error('signal-cli down'));

    await expect(
      sendStartupNotification(mockSignalClient as any, baseConfig)
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Write the failing tests for `sendErrorNotification`**

Add to the same file:

```typescript
describe('sendErrorNotification', () => {
  const mockSignalClient = {
    sendMessage: vi.fn().mockResolvedValue(undefined),
  };

  const baseConfig = {
    startupNotify: true,
    testGroupId: 'test-group-123',
    timezone: 'Australia/Sydney',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should send error message with error details', async () => {
    const error = new Error('Something broke');

    await sendErrorNotification(mockSignalClient as any, baseConfig, error);

    expect(mockSignalClient.sendMessage).toHaveBeenCalledOnce();
    const msg = mockSignalClient.sendMessage.mock.calls[0][1];
    expect(msg).toContain('Bot error');
    expect(msg).toContain('Something broke');
    expect(mockSignalClient.sendMessage.mock.calls[0][0]).toBe('test-group-123');
  });

  it('should include stack trace in error message', async () => {
    const error = new Error('Stack test');

    await sendErrorNotification(mockSignalClient as any, baseConfig, error);

    const msg = mockSignalClient.sendMessage.mock.calls[0][1];
    expect(msg).toContain('Stack test');
    expect(msg).toContain('at '); // stack trace lines
  });

  it('should truncate long error messages to 2000 chars', async () => {
    const error = new Error('x'.repeat(3000));

    await sendErrorNotification(mockSignalClient as any, baseConfig, error);

    const msg = mockSignalClient.sendMessage.mock.calls[0][1];
    expect(msg.length).toBeLessThanOrEqual(2000);
  });

  it('should handle non-Error objects gracefully', async () => {
    await sendErrorNotification(mockSignalClient as any, baseConfig, 'string error');

    const msg = mockSignalClient.sendMessage.mock.calls[0][1];
    expect(msg).toContain('string error');
  });

  it('should not send when startupNotify is false', async () => {
    await sendErrorNotification(
      mockSignalClient as any,
      { ...baseConfig, startupNotify: false },
      new Error('test'),
    );

    expect(mockSignalClient.sendMessage).not.toHaveBeenCalled();
  });

  it('should not throw if sendMessage fails', async () => {
    mockSignalClient.sendMessage.mockRejectedValueOnce(new Error('signal-cli down'));

    await expect(
      sendErrorNotification(mockSignalClient as any, baseConfig, new Error('test'))
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd bot && npx vitest run tests/notifications.test.ts`
Expected: FAIL — `../src/notifications` module does not exist

- [ ] **Step 4: Implement the notification functions**

Create `bot/src/notifications.ts` with the following content:

```typescript
import fs from 'node:fs';
import path from 'node:path';
import { logger } from './logger';

export interface NotifyConfig {
  startupNotify: boolean;
  testGroupId: string;
  timezone: string;
}

export async function sendStartupNotification(
  signalClient: { sendMessage(groupId: string, message: string): Promise<void> },
  config: NotifyConfig,
): Promise<void> {
  if (!config.startupNotify) return;

  try {
    let commitHash = 'unknown';
    try {
      commitHash = fs.readFileSync(path.resolve(__dirname, '../../VERSION'), 'utf-8').trim();
    } catch {
      // VERSION file missing — running in dev or .git not available
    }

    const now = new Date().toLocaleString('en-AU', {
      timeZone: config.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short',
    });

    await signalClient.sendMessage(config.testGroupId, `Bot online (${commitHash}) — ${now}`);
  } catch (error) {
    logger.error('Failed to send startup notification:', error);
  }
}

export async function sendErrorNotification(
  signalClient: { sendMessage(groupId: string, message: string): Promise<void> },
  config: NotifyConfig,
  error: unknown,
): Promise<void> {
  if (!config.startupNotify) return;

  try {
    const errorStr = error instanceof Error
      ? `${error.message}\n${error.stack ?? ''}`
      : String(error);

    const message = `Bot error — shutting down\n\n${errorStr}`.slice(0, 2000);
    await signalClient.sendMessage(config.testGroupId, message);
  } catch {
    // Best-effort — if signal-cli isn't available, just let it go
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd bot && npx vitest run tests/notifications.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Run full test suite to check for regressions**

Run: `cd bot && npx vitest run`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add bot/src/notifications.ts bot/tests/notifications.test.ts
git commit -m "feat: add startup and error notification functions"
```

---

### Task 3: Wire notifications into startup and error handlers

**Files:**
- Modify: `bot/src/index.ts`

- [ ] **Step 1: Add import for notifications module**

Add to the imports at the top of `bot/src/index.ts`:

```typescript
import { sendStartupNotification, sendErrorNotification } from './notifications';
```

- [ ] **Step 2: Call `sendStartupNotification` after `waitForReady()`**

In the `main()` function, after `await signalClient.waitForReady();` (line 95) and before the polling loop starts (line 98), add:

```typescript
await sendStartupNotification(signalClient, config);
```

- [ ] **Step 3: Wire `sendErrorNotification` into the `unhandledRejection` handler**

Replace the current handler at line 89-91:

```typescript
process.on('unhandledRejection', reason => {
  logger.error('Unhandled rejection:', reason);
});
```

With:

```typescript
process.on('unhandledRejection', async (reason) => {
  logger.error('Unhandled rejection:', reason);
  await sendErrorNotification(signalClient, config, reason);
  process.exit(1);
});
```

Note: `signalClient` and `config` are in scope because the handler is registered inside `main()` after they're initialized.

- [ ] **Step 4: Wire `sendErrorNotification` into `main().catch()`**

Replace the current fatal error handler at line 194-197:

```typescript
main().catch(error => {
  logger.error('Fatal error:', error);
  process.exit(1);
});
```

With:

```typescript
main().catch(async (error) => {
  logger.error('Fatal error:', error);
  // Best-effort: signalClient may not be initialized if error was during startup
  // This catch can't access signalClient from main's scope, so create a temporary one
  try {
    const config = Config.load();
    if (config.startupNotify) {
      const tempClient = new SignalClient(config.signalCliUrl, config.botPhoneNumber);
      await sendErrorNotification(tempClient, config, error);
    }
  } catch {
    // Config or signal-cli not available — just exit
  }
  process.exit(1);
});
```

- [ ] **Step 5: Run full test suite**

Run: `cd bot && npx vitest run`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add bot/src/index.ts
git commit -m "feat: wire startup/error notifications into bot lifecycle"
```

---

### Task 4: Deploy script writes VERSION file

**Files:**
- Modify: `scripts/deploy-nuc.sh`
- Modify: `.gitignore`

- [ ] **Step 1: Add `VERSION` to `.gitignore`**

Add `VERSION` to the end of `.gitignore`.

- [ ] **Step 2: Add VERSION file creation and trap cleanup to deploy script**

In `scripts/deploy-nuc.sh`, after the variable declarations (line 9) and before the first echo (line 11), add:

```bash
# Write commit hash for startup notification
git rev-parse --short HEAD > "$REPO_DIR/VERSION"
cleanup_version() { rm -f "$REPO_DIR/VERSION"; }
trap cleanup_version EXIT
```

The `VERSION` file is created in the repo root, picked up by the existing rsync, and cleaned up on script exit (success or failure) via the `EXIT` trap.

- [ ] **Step 3: Verify manually**

Run: `cd /home/zknowles/personal/signal-bot && bash -c 'git rev-parse --short HEAD > VERSION && cat VERSION && rm VERSION'`
Expected: Prints a short commit hash like `3c80e7c`

- [ ] **Step 4: Commit**

```bash
git add scripts/deploy-nuc.sh .gitignore
git commit -m "feat: deploy script writes VERSION file for startup notification"
```

---

### Task 5: Update CLAUDE.md documentation

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add `STARTUP_NOTIFY` to NUC .env Differences section**

In the `CLAUDE.md` file, find the "NUC .env Differences" section. Add `STARTUP_NOTIFY=true` to the bullet list:

```markdown
- `STARTUP_NOTIFY=true` (sends startup/error notifications to Bot Test channel)
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add STARTUP_NOTIFY to NUC .env differences"
```

---

### Task 6: Manual integration test

This is not automated — verify the feature end-to-end after deploying.

- [ ] **Step 1: Deploy to NUC**

```bash
./scripts/deploy-nuc.sh
```

- [ ] **Step 2: Add `STARTUP_NOTIFY=true` to NUC's `bot/.env`**

```bash
ssh zknowles@192.168.0.239 "echo 'STARTUP_NOTIFY=true' >> ~/signal-bot/bot/.env"
ssh zknowles@192.168.0.239 "sudo systemctl restart signal-bot"
```

- [ ] **Step 3: Verify startup notification**

Check the Bot Test Signal group for a message like:
```
Bot online (3c80e7c) — 18/03/2026, 14:32 AEDT
```

- [ ] **Step 4: Verify VERSION file cleanup**

```bash
ls VERSION 2>/dev/null && echo "FAIL: VERSION file not cleaned up" || echo "OK: VERSION file cleaned up"
```
