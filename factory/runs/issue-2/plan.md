# Image Attachment Support — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Store image attachments in SQLite and expose them to Claude via an MCP tool, so Claude can view and respond to images sent in Signal messages.

**Architecture:** When signal-cli delivers a message with image attachments, the bot reads the file from signal-cli's attachment directory and stores the raw binary (as BLOB) in a new `attachment_data` table in SQLite. Conversation context includes `[Image: attachment://<id>]` references. A new `images` MCP server exposes a `view_image` tool that retrieves the image from the DB, base64-encodes it, and returns it as an MCP image content block, enabling Claude's multimodal vision.

**Tech Stack:** TypeScript, better-sqlite3, vitest, MCP protocol (image content blocks)

---

### Task 0: Validate MCP image content blocks work with Claude CLI

**Goal:** Confirm that Claude CLI correctly processes `{ type: 'image', data, mimeType }` content blocks returned from MCP tool results before building the full pipeline.

**Step 1:** Create a minimal test MCP server that returns an image content block
**Step 2:** Wire it to `claude -p` with `--mcp-config`
**Step 3:** Ask Claude to describe the image
**Step 4:** Verify Claude can see and describe the image content

If this fails, fall back to a file-path approach where the MCP tool writes the image to a temp file and returns the path for Claude's Read tool. The rest of the plan remains the same either way — only the MCP server's response format changes.

---

### Task 1: Create AttachmentStore with DB table and migration

**Files:**
- Create: `bot/src/stores/attachmentStore.ts`
- Create: `bot/tests/stores/attachmentStore.test.ts`
- Modify: `bot/src/db.ts` (add migration v4)
- Modify: `bot/src/types.ts` (add `Attachment` type)

The `attachment_data` table stores image binary data as BLOB (not base64 TEXT — avoids 33% storage inflation). Base64 encoding happens only at retrieval time in the MCP server.

**Step 1: Write the failing test**

```typescript
// bot/tests/stores/attachmentStore.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseConnection } from '../src/db';
import { AttachmentStore } from '../src/stores/attachmentStore';

describe('AttachmentStore', () => {
  let conn: DatabaseConnection;
  let store: AttachmentStore;

  beforeEach(() => {
    conn = new DatabaseConnection(':memory:');
    store = new AttachmentStore(conn);
  });

  afterEach(() => {
    conn.close();
  });

  describe('save', () => {
    it('should save and retrieve an attachment', () => {
      const imgData = Buffer.from('fake jpeg data');
      store.save({
        id: 'abc-123',
        groupId: 'g1',
        sender: '+61400111222',
        contentType: 'image/jpeg',
        size: imgData.length,
        filename: 'photo.jpg',
        data: imgData,
        timestamp: Date.now(),
      });

      const attachment = store.get('abc-123');
      expect(attachment).not.toBeNull();
      expect(attachment!.id).toBe('abc-123');
      expect(attachment!.contentType).toBe('image/jpeg');
      expect(Buffer.isBuffer(attachment!.data)).toBe(true);
      expect(attachment!.data.toString()).toBe('fake jpeg data');
      expect(attachment!.filename).toBe('photo.jpg');
    });

    it('should handle duplicate IDs by updating', () => {
      const ts = Date.now();
      store.save({
        id: 'abc-123', groupId: 'g1', sender: '+61400111222',
        contentType: 'image/jpeg', size: 5, filename: null,
        data: Buffer.from('first'), timestamp: ts,
      });
      store.save({
        id: 'abc-123', groupId: 'g1', sender: '+61400111222',
        contentType: 'image/jpeg', size: 6, filename: null,
        data: Buffer.from('second'), timestamp: ts,
      });

      const attachment = store.get('abc-123');
      expect(attachment!.data.toString()).toBe('second');
    });
  });

  describe('get', () => {
    it('should return null for non-existent attachment', () => {
      expect(store.get('nonexistent')).toBeNull();
    });
  });

  describe('trimOlderThan', () => {
    it('should delete attachments older than cutoff', () => {
      const now = Date.now();
      store.save({ id: 'old', groupId: 'g1', sender: 's1', contentType: 'image/png', size: 100, filename: null, data: Buffer.from('old'), timestamp: now - 100000 });
      store.save({ id: 'new', groupId: 'g1', sender: 's1', contentType: 'image/png', size: 100, filename: null, data: Buffer.from('new'), timestamp: now });

      store.trimOlderThan(now - 50000);

      expect(store.get('old')).toBeNull();
      expect(store.get('new')).not.toBeNull();
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd bot && npx vitest run tests/stores/attachmentStore.test.ts`
Expected: FAIL — module not found

**Step 3: Add Attachment type to types.ts**

Add to `bot/src/types.ts`:

```typescript
export interface Attachment {
  id: string;
  groupId: string;
  sender: string;
  contentType: string;
  size: number;
  filename: string | null;
  data: Buffer; // raw binary, stored as BLOB in SQLite
  timestamp: number;
}
```

**Step 4: Add migration v4 to db.ts**

In `runMigrations()`, add after the v3 block:

```typescript
if (currentVersion < 4) {
  this.migrateToV4();
  this.setSchemaVersion(4);
}
```

Add method:

```typescript
private migrateToV4(): void {
  this.db.exec(`
    CREATE TABLE IF NOT EXISTS attachment_data (
      id TEXT PRIMARY KEY,
      groupId TEXT NOT NULL,
      sender TEXT NOT NULL,
      contentType TEXT NOT NULL,
      size INTEGER NOT NULL,
      filename TEXT,
      data BLOB NOT NULL,
      timestamp INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_attachment_data_group
    ON attachment_data(groupId, timestamp DESC);
  `);
}
```

**Step 5: Write AttachmentStore**

```typescript
// bot/src/stores/attachmentStore.ts
import type { DatabaseConnection } from '../db';
import { wrapSqliteError } from '../db';
import type { Attachment } from '../types';

export class AttachmentStore {
  private conn: DatabaseConnection;
  private stmts: {
    upsert: import('better-sqlite3').Statement;
    get: import('better-sqlite3').Statement;
    trim: import('better-sqlite3').Statement;
  };

  constructor(conn: DatabaseConnection) {
    this.conn = conn;
    this.stmts = {
      upsert: conn.db.prepare(`
        INSERT INTO attachment_data (id, groupId, sender, contentType, size, filename, data, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET data = excluded.data
      `),
      get: conn.db.prepare('SELECT * FROM attachment_data WHERE id = ?'),
      trim: conn.db.prepare('DELETE FROM attachment_data WHERE timestamp < ?'),
    };
  }

  save(attachment: Attachment): void {
    this.conn.ensureOpen();
    try {
      this.stmts.upsert.run(
        attachment.id, attachment.groupId, attachment.sender,
        attachment.contentType, attachment.size, attachment.filename,
        attachment.data, attachment.timestamp,
      );
    } catch (error) {
      wrapSqliteError(error, 'save attachment');
    }
  }

  get(id: string): Attachment | null {
    this.conn.ensureOpen();
    try {
      return (this.stmts.get.get(id) as Attachment) ?? null;
    } catch (error) {
      wrapSqliteError(error, 'get attachment');
    }
  }

  trimOlderThan(cutoffTimestamp: number): void {
    this.conn.ensureOpen();
    try {
      this.stmts.trim.run(cutoffTimestamp);
    } catch (error) {
      wrapSqliteError(error, 'trim attachments');
    }
  }
}
```

**Step 6: Run tests**

Run: `cd bot && npx vitest run tests/stores/attachmentStore.test.ts`
Expected: PASS

**Step 7: Commit**

```bash
git add bot/src/types.ts bot/src/db.ts bot/src/stores/attachmentStore.ts bot/tests/stores/attachmentStore.test.ts
git commit -m "feat: add AttachmentStore for image binary storage in SQLite"
```

---

### Task 2: Wire AttachmentStore into Storage facade

**Files:**
- Modify: `bot/src/storage.ts`
- Modify: `bot/tests/storage.test.ts` (if attachment delegation tests needed)

**Step 1: Add attachment delegation to Storage**

In `bot/src/storage.ts`, add:

```typescript
import { AttachmentStore } from './stores/attachmentStore';
import type { Attachment } from './types';
```

Add to class:

```typescript
readonly attachments: AttachmentStore;
```

In constructor after `this.personas = ...`:

```typescript
this.attachments = new AttachmentStore(this.conn);
```

Add delegate methods:

```typescript
// === Attachment methods (delegate to AttachmentStore) ===

saveAttachment(attachment: Attachment): void {
  this.attachments.save(attachment);
}

getAttachment(id: string): Attachment | null {
  return this.attachments.get(id);
}

trimAttachments(cutoffTimestamp: number): void {
  this.attachments.trimOlderThan(cutoffTimestamp);
}
```

**Step 2: Run existing tests to verify nothing broke**

Run: `cd bot && npx vitest run`
Expected: All tests PASS

**Step 3: Commit**

```bash
git add bot/src/storage.ts
git commit -m "feat: wire AttachmentStore into Storage facade"
```

---

### Task 3: Ingest attachment files on message receive

**Files:**
- Modify: `bot/src/signalClient.ts` (add `downloadAttachment` method)
- Modify: `bot/src/messageHandler.ts` (save attachments to DB on receive)
- Create: `bot/tests/signalClient.download.test.ts`

When a message arrives with image attachments, read the file from signal-cli's attachment directory and save the base64 data to the DB.

**Step 1: Write failing test for downloadAttachment**

```typescript
// In bot/tests/signalClient.test.ts or a new file
// Test that downloadAttachment reads from the attachments dir

describe('downloadAttachment', () => {
  it('should read file from attachments directory and return base64', async () => {
    // We'll use a tmp dir with a fake attachment file
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-test-'));
    const attachmentId = 'test-attachment-id';
    fs.writeFileSync(path.join(tmpDir, attachmentId), Buffer.from('fake image data'));

    const client = new SignalClient('http://localhost:8080', '+1234567890');
    const result = client.readAttachmentFile(tmpDir, attachmentId);

    expect(result).not.toBeNull();
    expect(Buffer.isBuffer(result!.data)).toBe(true);
    expect(result!.data.toString()).toBe('fake image data');

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('should return null when file does not exist', () => {
    const client = new SignalClient('http://localhost:8080', '+1234567890');
    const result = client.readAttachmentFile('/nonexistent/path', 'missing-id');
    expect(result).toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd bot && npx vitest run tests/signalClient.test.ts`
Expected: FAIL — method doesn't exist

**Step 3: Add readAttachmentFile to SignalClient**

In `bot/src/signalClient.ts`:

```typescript
import fs from 'node:fs';
import path from 'node:path';

// In the class:
readAttachmentFile(attachmentsDir: string, attachmentId: string): { data: Buffer } | null {
  const filePath = path.join(attachmentsDir, attachmentId);
  try {
    const data = fs.readFileSync(filePath);
    return { data };
  } catch {
    return null;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd bot && npx vitest run tests/signalClient.test.ts`
Expected: PASS

**Step 5: Wire ingestion into messageHandler**

In `bot/src/messageHandler.ts`, in the `handleMessage` method, after storing the message and before LLM processing, add image ingestion. Also add it to `handleMessageBatch`.

In `handleMessage`, after `this.storage.addMessage(...)` (around line 103-110):

```typescript
// Ingest image attachments into DB
for (const att of attachments) {
  if (att.contentType.startsWith('image/')) {
    const file = this.signalClient.readAttachmentFile(this.appConfig.attachmentsDir, att.id);
    if (file) {
      this.storage.saveAttachment({
        id: att.id,
        groupId,
        sender,
        contentType: att.contentType,
        size: att.size,
        filename: att.filename,
        data: file.data,
        timestamp,
      });
    }
  }
}
```

Similarly in `handleMessageBatch`, after storing messages:

```typescript
// Ingest image attachments into DB
for (const msg of validMessages) {
  for (const att of msg.attachments) {
    if (att.contentType.startsWith('image/')) {
      const file = this.signalClient.readAttachmentFile(this.appConfig.attachmentsDir, att.id);
      if (file) {
        this.storage.saveAttachment({
          id: att.id,
          groupId,
          sender: msg.sender,
          contentType: att.contentType,
          size: att.size,
          filename: att.filename,
          data: file.data,
          timestamp: msg.timestamp,
        });
      }
    }
  }
}
```

**Step 6: Add test for ingestion in messageHandler.test.ts**

```typescript
describe('image attachment ingestion', () => {
  it('should save image attachment data to storage on receive', async () => {
    const fakeBuffer = Buffer.from('fake image');
    mockSignal.readAttachmentFile = vi.fn().mockReturnValue({ data: fakeBuffer });
    mockStorage.saveAttachment = vi.fn();

    const handler = new MessageHandler(['@bot'], {
      storage: mockStorage,
      llmClient: mockLLM,
      signalClient: mockSignal,
      appConfig: makeAppConfig({ attachmentsDir: '/data/attachments' }),
    });

    await handler.handleMessage('g1', 'Alice', '@bot check this', 1000, [
      { id: 'img-abc', contentType: 'image/jpeg', size: 50000, filename: 'photo.jpg' },
    ]);

    expect(mockSignal.readAttachmentFile).toHaveBeenCalledWith('/data/attachments', 'img-abc');
    expect(mockStorage.saveAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'img-abc',
        groupId: 'g1',
        contentType: 'image/jpeg',
        data: fakeBuffer,
      }),
    );
  });

  it('should not crash when attachment file is missing', async () => {
    mockSignal.readAttachmentFile = vi.fn().mockReturnValue(null);
    mockStorage.saveAttachment = vi.fn();

    const handler = new MessageHandler(['@bot'], {
      storage: mockStorage,
      llmClient: mockLLM,
      signalClient: mockSignal,
    });

    await handler.handleMessage('g1', 'Alice', '@bot check this', 1000, [
      { id: 'img-missing', contentType: 'image/jpeg', size: 50000, filename: null },
    ]);

    expect(mockStorage.saveAttachment).not.toHaveBeenCalled();
  });

  it('should skip non-image attachments during ingestion', async () => {
    mockSignal.readAttachmentFile = vi.fn();
    mockStorage.saveAttachment = vi.fn();

    const handler = new MessageHandler(['@bot'], {
      storage: mockStorage,
      llmClient: mockLLM,
      signalClient: mockSignal,
    });

    await handler.handleMessage('g1', 'Alice', '@bot', 1000, [
      { id: 'voice-abc', contentType: 'audio/aac', size: 5000, filename: null },
    ]);

    expect(mockSignal.readAttachmentFile).not.toHaveBeenCalled();
    expect(mockStorage.saveAttachment).not.toHaveBeenCalled();
  });
});
```

**Step 7: Run all tests**

Run: `cd bot && npx vitest run`
Expected: PASS

**Step 8: Commit**

```bash
git add bot/src/signalClient.ts bot/src/messageHandler.ts bot/tests/signalClient.test.ts bot/tests/messageHandler.test.ts
git commit -m "feat: ingest image attachments from filesystem into SQLite on receive"
```

---

### Task 4: Update context builder to use attachment:// references

**Files:**
- Modify: `bot/src/contextBuilder.ts`
- Modify: `bot/tests/contextBuilder.test.ts`

Change `[Image attached: /data/signal-attachments/abc]` to `[Image: attachment://abc]` so Claude sees a clean reference it can pass to the MCP tool.

**Step 1: Write the failing test**

In `bot/tests/contextBuilder.test.ts`, update the existing image tests:

```typescript
describe('formatImageAttachment', () => {
  it('should format image attachment as attachment:// URI', () => {
    const builder = new ContextBuilder({ ...defaultConfig, attachmentsDir: '/data/attachments' });
    const result = builder.formatImageAttachment('img-abc');
    expect(result).toBe('[Image: attachment://img-abc]');
  });
});
```

And update `formatMessageForContext` image test:

```typescript
it('should include image attachment lines with attachment:// URIs', () => {
  const builder = new ContextBuilder({ ...defaultConfig, attachmentsDir: '/data/attachments' });
  const msg: Message = {
    id: 1, groupId: 'g1', sender: 'Alice', content: 'check this',
    timestamp: 1000, isBot: false,
    attachments: [{ id: 'img-123', contentType: 'image/jpeg', size: 50000, filename: 'photo.jpg' }],
  };
  const result = builder.formatMessageForContext(msg);
  expect(result).toContain('[Image: attachment://img-123]');
});
```

**Step 2: Run test to verify it fails**

Run: `cd bot && npx vitest run tests/contextBuilder.test.ts`
Expected: FAIL — old format doesn't match

**Step 3: Update formatImageAttachment**

In `bot/src/contextBuilder.ts`:

```typescript
formatImageAttachment(attachmentId: string): string {
  return `[Image: attachment://${attachmentId}]`;
}
```

**Step 4: Update IMAGE_INSTRUCTIONS**

```typescript
const IMAGE_INSTRUCTIONS =
  'When an image is referenced (shown as [Image: attachment://<id>] in the conversation), use the view_image tool with that attachment ID to view it. Then respond about the image content. Images may appear in the current message or in recent conversation history.';
```

**Step 5: Run tests**

Run: `cd bot && npx vitest run tests/contextBuilder.test.ts`
Expected: PASS (update any other tests that assert the old format)

**Step 6: Update messageHandler.test.ts assertions**

Update the image attachment tests to expect the new `attachment://` format instead of file paths.

**Step 7: Run all tests**

Run: `cd bot && npx vitest run`
Expected: PASS

**Step 8: Commit**

```bash
git add bot/src/contextBuilder.ts bot/tests/contextBuilder.test.ts bot/tests/messageHandler.test.ts
git commit -m "feat: use attachment:// URIs in conversation context instead of file paths"
```

---

### Task 5: Create images MCP server with view_image tool

**Files:**
- Create: `bot/src/mcp/servers/images.ts`
- Create: `bot/tests/imagesMcpServer.test.ts`
- Modify: `bot/src/mcp/servers/index.ts` (add to ALL_SERVERS)

This MCP server exposes a `view_image` tool. Claude calls it with an attachment ID, and it returns the image from the DB as an MCP image content block.

**Step 1: Write the failing test**

```typescript
// bot/tests/imagesMcpServer.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseConnection } from '../src/db';
import { AttachmentStore } from '../src/stores/attachmentStore';
import { imagesServer } from '../src/mcp/servers/images';

vi.mock('../src/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn(), step: vi.fn(), compact: vi.fn() },
}));

describe('images MCP server', () => {
  let conn: DatabaseConnection;
  let store: AttachmentStore;

  beforeEach(() => {
    conn = new DatabaseConnection(':memory:');
    store = new AttachmentStore(conn);
  });

  afterEach(() => {
    conn.close();
  });

  describe('view_image', () => {
    it('should return image content block for valid attachment ID', async () => {
      store.save({
        id: 'img-123', groupId: 'g1', sender: '+61400111222',
        contentType: 'image/jpeg', size: 1234, filename: 'photo.jpg',
        data: '/9j/4AAQSkZJRg==', // fake base64 jpeg header
        timestamp: Date.now(),
      });

      // The handler needs DB access — we'll set it up via env + init
      const handler = imagesServer.handlers.view_image;
      // We need to test with the store injected — see implementation for how
      const result = await handler({ attachmentId: 'img-123' });
      expect(result.isError).toBeFalsy();
      expect(result.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'image', mimeType: 'image/jpeg' }),
        ]),
      );
    });

    it('should return error for non-existent attachment', async () => {
      const handler = imagesServer.handlers.view_image;
      const result = await handler({ attachmentId: 'nonexistent' });
      expect(result.isError).toBe(true);
    });

    it('should require attachmentId parameter', async () => {
      const handler = imagesServer.handlers.view_image;
      const result = await handler({});
      expect(result.isError).toBe(true);
    });
  });
});
```

Note: The exact test setup will depend on how the server accesses the DB. The server will use `readStorageEnv()` in `onInit` to get the DB path, then create its own `DatabaseConnection` and `AttachmentStore`. For testing, we'll need to either mock the env or inject the store. Follow the pattern from other MCP server tests.

**Step 2: Run test to verify it fails**

Run: `cd bot && npx vitest run tests/imagesMcpServer.test.ts`
Expected: FAIL — module not found

**Step 3: Write the images MCP server**

```typescript
// bot/src/mcp/servers/images.ts
import { DatabaseConnection } from '../../db';
import { AttachmentStore } from '../../stores/attachmentStore';
import { readStorageEnv } from '../env';
import { error } from '../result';
import { runServer } from '../runServer';
import type { McpServerDefinition, ToolResult } from '../types';
import { requireString } from '../validate';

let store: AttachmentStore | null = null;
let conn: DatabaseConnection | null = null;

const TOOLS = [
  {
    name: 'view_image',
    title: 'View Image Attachment',
    description:
      'View an image attachment from a Signal message. Pass the attachment ID from an [Image: attachment://<id>] reference in the conversation. Returns the image for visual analysis.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        attachmentId: {
          type: 'string',
          description: 'The attachment ID from an attachment:// URI in the conversation',
        },
      },
      required: ['attachmentId'],
    },
  },
];

export const imagesServer: McpServerDefinition = {
  serverName: 'signal-bot-images',
  configKey: 'images',
  entrypoint: 'images',
  tools: TOOLS,
  envMapping: { DB_PATH: 'dbPath' },
  handlers: {
    view_image(args): ToolResult {
      const id = requireString(args, 'attachmentId');
      if (id.error) return id.error;

      if (!store) return error('Image store not initialized.');

      const attachment = store.get(id.value);
      if (!attachment) return error(`Attachment not found: ${id.value}`);

      const base64Data = Buffer.isBuffer(attachment.data)
        ? attachment.data.toString('base64')
        : attachment.data;

      return {
        content: [
          { type: 'image', data: base64Data, mimeType: attachment.contentType },
          { type: 'text', text: `Image: ${attachment.filename || id.value} (${attachment.contentType}, ${Math.round(attachment.size / 1024)}KB)` },
        ],
      };
    },
  },
  onInit() {
    const env = readStorageEnv();
    conn = new DatabaseConnection(env.dbPath);
    store = new AttachmentStore(conn);
    console.error('Images MCP server started');
  },
  onClose() {
    conn?.close();
  },
};

if (require.main === module) {
  runServer(imagesServer);
}
```

**Step 4: Update MCP types to support image content blocks (do this BEFORE writing the server)**

In `bot/src/mcp/types.ts`, update `ToolResult`:

```typescript
export type ToolResultContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export type ToolResult = {
  content: ToolResultContent[];
  isError?: boolean;
};
```

**Step 5: Register in servers/index.ts**

In `bot/src/mcp/servers/index.ts`:

```typescript
import { imagesServer } from './images';

export const ALL_SERVERS: McpServerDefinition[] = [
  // ... existing servers ...
  imagesServer,
];
```

**Step 6: Run tests**

Run: `cd bot && npx vitest run`
Expected: PASS

**Step 7: Commit**

```bash
git add bot/src/mcp/types.ts bot/src/mcp/servers/images.ts bot/src/mcp/servers/index.ts bot/tests/imagesMcpServer.test.ts
git commit -m "feat: add images MCP server with view_image tool for DB-backed attachments"
```

---

### Task 6: Update mock Signal server for attachment testing

**Files:**
- Modify: `bot/src/mock/signalServer.ts`

Add the ability to queue messages with image attachments, and serve a fake attachment file when the bot reads it.

**Step 1: Update Envelope interface**

```typescript
interface Envelope {
  envelope: {
    sourceNumber: string;
    sourceUuid: string;
    timestamp: number;
    dataMessage: {
      timestamp: number;
      message: string;
      groupInfo: { groupId: string };
      attachments?: Array<{
        id: string;
        contentType: string;
        size: number;
        filename: string | null;
      }>;
    };
  };
}
```

**Step 2: Add /image command**

In the `rl.on('line')` handler, add a `/image` command that queues a message with a fake image attachment:

```typescript
if (cmd === '/image') {
  // Create a tiny 1x1 red PNG for testing
  const fakePng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
  const attachmentId = `mock-img-${Date.now()}`;
  // Write fake file to attachments dir
  const attachDir = process.env.ATTACHMENTS_DIR || './data/signal-attachments';
  fs.mkdirSync(attachDir, { recursive: true });
  fs.writeFileSync(path.join(attachDir, attachmentId), Buffer.from(fakePng, 'base64'));

  const envelope = createEnvelopeWithAttachments('claude: what is this image?', [{
    id: attachmentId,
    contentType: 'image/png',
    size: Buffer.from(fakePng, 'base64').length,
    filename: 'test-image.png',
  }]);
  messageQueue.push(envelope);
  console.log(`${GREEN}[QUEUED]${RESET} image message with attachment ${attachmentId}`);
  rl.prompt();
  return;
}
```

Add `createEnvelopeWithAttachments`:

```typescript
function createEnvelopeWithAttachments(
  text: string,
  attachments: Array<{ id: string; contentType: string; size: number; filename: string | null }>,
): Envelope {
  const now = Date.now();
  return {
    envelope: {
      sourceNumber: SENDER,
      sourceUuid: 'mock-uuid-1234',
      timestamp: now,
      dataMessage: {
        timestamp: now,
        message: text,
        groupInfo: { groupId: GROUP_ID },
        attachments,
      },
    },
  };
}
```

**Step 3: Update /help**

Add `/image` to help output.

**Step 4: Run mock server manually to verify**

Run: `cd bot && npm run mock-signal`
Type: `/image`
Expected: See `[QUEUED] image message with attachment mock-img-...`

**Step 5: Commit**

```bash
git add bot/src/mock/signalServer.ts
git commit -m "feat: add /image command to mock signal server for attachment testing"
```

---

### Task 7: Integration test — end-to-end image flow

**Files:**
- Modify: `bot/tests/integration.test.ts` (or create `bot/tests/imageAttachment.integration.test.ts`)

Test the full flow: message with attachment → ingestion → context building → MCP tool retrieval.

**Step 1: Write integration test**

```typescript
describe('image attachment end-to-end', () => {
  it('should ingest image, include reference in context, and serve via MCP', () => {
    // 1. Create in-memory DB
    const conn = new DatabaseConnection(':memory:');
    const attachmentStore = new AttachmentStore(conn);

    // 2. Save an attachment (simulating ingestion)
    attachmentStore.save({
      id: 'img-e2e', groupId: 'g1', sender: '+61400111222',
      contentType: 'image/png', size: 100, filename: 'test.png',
      data: 'iVBORw0KGgo=', timestamp: Date.now(),
    });

    // 3. Verify context builder formats correctly
    const builder = new ContextBuilder({
      systemPrompt: '', timezone: 'Australia/Sydney',
      contextTokenBudget: 4000, attachmentsDir: '/unused',
    });
    const formatted = builder.formatImageAttachment('img-e2e');
    expect(formatted).toBe('[Image: attachment://img-e2e]');

    // 4. Verify retrieval from store
    const retrieved = attachmentStore.get('img-e2e');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.data).toBe('iVBORw0KGgo=');
    expect(retrieved!.contentType).toBe('image/png');

    conn.close();
  });
});
```

**Step 2: Run test**

Run: `cd bot && npx vitest run tests/imageAttachment.integration.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add bot/tests/imageAttachment.integration.test.ts
git commit -m "test: add integration test for image attachment end-to-end flow"
```

---

### Task 8: Update CLAUDE.md documentation

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Update MCP servers section**

Add to the MCP servers list:

```
- `images.ts` — View image attachments stored in DB (1 tool)
```

**Step 2: Update architecture notes**

Add a brief note about attachment storage:

```
### Image Attachments
Images sent in Signal messages are stored as base64 in the `attachment_data` SQLite table.
Conversation context references them as `[Image: attachment://<id>]`.
Claude uses the `view_image` MCP tool to retrieve and view images.
```

**Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document image attachment architecture and images MCP server"
```

---

## Revisions

**After devil's advocate review (see `plan-review.md`):**

1. **Added Task 0: MCP image validation spike** — The critical concern that Claude CLI may not process `{ type: 'image' }` content blocks from MCP tool results. Added a validation step before building the full pipeline. Fallback: write image to temp file and return path for Claude's Read tool.

2. **Changed from base64 TEXT to BLOB storage** — Eliminates 33% storage inflation. `Attachment.data` is now `Buffer`, not `string`. Base64 encoding happens only in the MCP server when building the response.

3. **Dropped `getMetadata()` and `listByGroup()` (YAGNI)** — Neither is called anywhere. Added `trimOlderThan()` instead for cleanup.

4. **Added `trimOlderThan()` for attachment cleanup** — Prevents unbounded DB growth. Can be wired into the same periodic cleanup as `trimMessages`.

5. **Removed `ImageToolResult` local type** — Updated the base `ToolResult` type to support image content blocks (Task 5 Step 4), so no local type escape hatch needed.

6. **Dismissed concern #6 (file paths already work)** — User explicitly requested DB storage: "I want all files saved to a DB so we don't lose them." This is a durability requirement, not over-engineering.

---

## Summary

| Task | Description | Files |
|------|-------------|-------|
| 0 | Validate MCP image content blocks with Claude CLI | spike/test only |
| 1 | AttachmentStore + DB migration (BLOB) | stores/attachmentStore.ts, db.ts, types.ts |
| 2 | Wire into Storage facade | storage.ts |
| 3 | Ingest attachments on receive | signalClient.ts, messageHandler.ts |
| 4 | Update context to attachment:// URIs | contextBuilder.ts |
| 5 | Images MCP server (view_image) | mcp/servers/images.ts, mcp/types.ts |
| 6 | Mock server /image command | mock/signalServer.ts |
| 7 | Integration test | tests/ |
| 8 | Documentation | CLAUDE.md |
