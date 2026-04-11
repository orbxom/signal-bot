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

  describe('listMetadata', () => {
    it('lists attachment metadata without data', () => {
      const now = Date.now();
      store.save({
        id: 'a1',
        groupId: 'g1',
        sender: 's1',
        contentType: 'image/jpeg',
        size: 100,
        filename: 'a.jpg',
        data: Buffer.from('data1'),
        timestamp: now,
      });
      store.save({
        id: 'a2',
        groupId: 'g2',
        sender: 's2',
        contentType: 'image/png',
        size: 200,
        filename: 'b.png',
        data: Buffer.from('data2'),
        timestamp: now + 1000,
      });
      const list = store.listMetadata();
      expect(list).toHaveLength(2);
      expect((list[0] as any).data).toBeUndefined();
      expect(list[0].id).toBeDefined();
    });

    it('filters by groupId', () => {
      const now = Date.now();
      store.save({
        id: 'a1',
        groupId: 'g1',
        sender: 's1',
        contentType: 'image/jpeg',
        size: 100,
        filename: null,
        data: Buffer.from('data1'),
        timestamp: now,
      });
      store.save({
        id: 'a2',
        groupId: 'g2',
        sender: 's2',
        contentType: 'image/png',
        size: 200,
        filename: null,
        data: Buffer.from('data2'),
        timestamp: now,
      });
      const filtered = store.listMetadata({ groupId: 'g1' });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].groupId).toBe('g1');
    });

    it('supports pagination', () => {
      const now = Date.now();
      for (let i = 0; i < 5; i++) {
        store.save({
          id: `a${i}`,
          groupId: 'g1',
          sender: 's1',
          contentType: 'image/jpeg',
          size: 100,
          filename: null,
          data: Buffer.from(`data${i}`),
          timestamp: now + i,
        });
      }
      const page = store.listMetadata({ limit: 2, offset: 2 });
      expect(page).toHaveLength(2);
    });
  });

  describe('getStats', () => {
    it('returns stats grouped by groupId', () => {
      const now = Date.now();
      store.save({
        id: 'a1',
        groupId: 'g1',
        sender: 's1',
        contentType: 'image/jpeg',
        size: 100,
        filename: null,
        data: Buffer.from('data1'),
        timestamp: now,
      });
      store.save({
        id: 'a2',
        groupId: 'g1',
        sender: 's1',
        contentType: 'image/png',
        size: 200,
        filename: null,
        data: Buffer.from('data22'),
        timestamp: now,
      });
      store.save({
        id: 'a3',
        groupId: 'g2',
        sender: 's2',
        contentType: 'image/jpeg',
        size: 50,
        filename: null,
        data: Buffer.from('data3'),
        timestamp: now,
      });
      const stats = store.getStats();
      expect(stats.countByGroup).toHaveLength(2);
      expect(stats.totalSize).toBeGreaterThan(0);
    });

    it('returns empty stats when no attachments', () => {
      const stats = store.getStats();
      expect(stats.totalSize).toBe(0);
      expect(stats.countByGroup).toHaveLength(0);
    });
  });

  describe('deleteById', () => {
    it('deletes an attachment by id', () => {
      store.save({
        id: 'a1',
        groupId: 'g1',
        sender: 's1',
        contentType: 'image/jpeg',
        size: 100,
        filename: null,
        data: Buffer.from('data'),
        timestamp: Date.now(),
      });
      const result = store.deleteById('a1');
      expect(result).toBe(true);
      expect(store.get('a1')).toBeNull();
    });

    it('returns false for non-existent id', () => {
      expect(store.deleteById('nonexistent')).toBe(false);
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
