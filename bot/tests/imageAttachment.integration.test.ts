import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ContextBuilder } from '../src/contextBuilder';
import { DatabaseConnection } from '../src/db';
import { AttachmentStore } from '../src/stores/attachmentStore';

describe('image attachment end-to-end', () => {
  let conn: DatabaseConnection;
  let store: AttachmentStore;

  beforeEach(() => {
    conn = new DatabaseConnection(':memory:');
    store = new AttachmentStore(conn);
  });

  afterEach(() => {
    conn.close();
  });

  it('should ingest image, format context reference, and retrieve from DB', () => {
    // 1. Simulate ingestion: save attachment to DB
    const imgData = Buffer.from('fake png image data');
    store.save({
      id: 'img-e2e',
      groupId: 'g1',
      sender: '+61400111222',
      contentType: 'image/png',
      size: imgData.length,
      filename: 'test.png',
      data: imgData,
      timestamp: Date.now(),
    });

    // 2. Verify context builder formats the reference correctly
    const builder = new ContextBuilder({
      systemPrompt: '',
      timezone: 'Australia/Sydney',
      contextTokenBudget: 4000,
      attachmentsDir: '/unused',
    });
    const formatted = builder.formatImageAttachment('img-e2e');
    expect(formatted).toBe('[Image: attachment://img-e2e]');

    // 3. Verify retrieval from store (as MCP server would do)
    const retrieved = store.get('img-e2e');
    expect(retrieved).not.toBeNull();
    expect(Buffer.isBuffer(retrieved!.data)).toBe(true);
    expect(retrieved!.data.toString()).toBe('fake png image data');
    expect(retrieved!.contentType).toBe('image/png');
    expect(retrieved!.filename).toBe('test.png');

    // 4. Verify base64 encoding works (as MCP server returns to Claude)
    const base64 = retrieved!.data.toString('base64');
    expect(base64).toBe(Buffer.from('fake png image data').toString('base64'));
  });

  it('should handle attachment with no filename', () => {
    store.save({
      id: 'img-noname',
      groupId: 'g1',
      sender: '+61400111222',
      contentType: 'image/jpeg',
      size: 100,
      filename: null,
      data: Buffer.from('jpeg data'),
      timestamp: Date.now(),
    });

    const retrieved = store.get('img-noname');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.filename).toBeNull();
    expect(retrieved!.contentType).toBe('image/jpeg');
  });

  it('should trim old attachments', () => {
    const now = Date.now();
    const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;
    const twoDaysAgo = now - 2 * 24 * 60 * 60 * 1000;

    store.save({
      id: 'old-img', groupId: 'g1', sender: 's1',
      contentType: 'image/png', size: 100, filename: null,
      data: Buffer.from('old'), timestamp: oneWeekAgo,
    });
    store.save({
      id: 'recent-img', groupId: 'g1', sender: 's1',
      contentType: 'image/png', size: 100, filename: null,
      data: Buffer.from('recent'), timestamp: twoDaysAgo,
    });

    // Trim anything older than 3 days
    const threeDaysAgo = now - 3 * 24 * 60 * 60 * 1000;
    store.trimOlderThan(threeDaysAgo);

    expect(store.get('old-img')).toBeNull();
    expect(store.get('recent-img')).not.toBeNull();
  });
});
