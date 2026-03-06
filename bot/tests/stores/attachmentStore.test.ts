import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseConnection } from '../../src/db';
import { AttachmentStore } from '../../src/stores/attachmentStore';

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
      expect(attachment?.id).toBe('abc-123');
      expect(attachment?.contentType).toBe('image/jpeg');
      expect(Buffer.isBuffer(attachment?.data)).toBe(true);
      expect(attachment?.data.toString()).toBe('fake jpeg data');
      expect(attachment?.filename).toBe('photo.jpg');
    });

    it('should handle duplicate IDs by updating', () => {
      const ts = Date.now();
      store.save({
        id: 'abc-123',
        groupId: 'g1',
        sender: '+61400111222',
        contentType: 'image/jpeg',
        size: 5,
        filename: null,
        data: Buffer.from('first'),
        timestamp: ts,
      });
      store.save({
        id: 'abc-123',
        groupId: 'g1',
        sender: '+61400111222',
        contentType: 'image/jpeg',
        size: 6,
        filename: null,
        data: Buffer.from('second'),
        timestamp: ts,
      });

      const attachment = store.get('abc-123');
      expect(attachment?.data.toString()).toBe('second');
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
      store.save({
        id: 'old',
        groupId: 'g1',
        sender: 's1',
        contentType: 'image/png',
        size: 100,
        filename: null,
        data: Buffer.from('old'),
        timestamp: now - 100000,
      });
      store.save({
        id: 'new',
        groupId: 'g1',
        sender: 's1',
        contentType: 'image/png',
        size: 100,
        filename: null,
        data: Buffer.from('new'),
        timestamp: now,
      });

      store.trimOlderThan(now - 50000);

      expect(store.get('old')).toBeNull();
      expect(store.get('new')).not.toBeNull();
    });
  });
});
