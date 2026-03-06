import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseConnection } from '../../src/db';
import { DOSSIER_TOKEN_LIMIT, DossierStore } from '../../src/stores/dossierStore';

describe('DossierStore', () => {
  let testDir: string;
  let conn: DatabaseConnection;
  let store: DossierStore;

  const setup = () => {
    testDir = mkdtempSync(join(tmpdir(), 'signal-bot-dossier-store-test-'));
    conn = new DatabaseConnection(join(testDir, 'test.db'));
    store = new DossierStore(conn);
    return store;
  };

  afterEach(() => {
    conn?.close();
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('upsert', () => {
    it('should create a new dossier', () => {
      setup();
      const dossier = store.upsert('group1', 'person1', 'Alice', 'Likes coffee');
      expect(dossier).toMatchObject({
        groupId: 'group1',
        personId: 'person1',
        displayName: 'Alice',
        notes: 'Likes coffee',
      });
      expect(dossier.id).toBeGreaterThan(0);
      expect(dossier.createdAt).toBeGreaterThan(0);
      expect(dossier.updatedAt).toBeGreaterThan(0);
    });

    it('should update an existing dossier with same groupId and personId', () => {
      setup();
      const first = store.upsert('group1', 'person1', 'Alice', 'Original notes');
      const second = store.upsert('group1', 'person1', 'Alice B', 'Updated notes');
      expect(second.id).toBe(first.id);
      expect(second.displayName).toBe('Alice B');
      expect(second.notes).toBe('Updated notes');
    });

    it('should reject empty groupId', () => {
      setup();
      expect(() => store.upsert('', 'person1', 'Alice', 'Notes')).toThrow('Invalid groupId: cannot be empty');
    });

    it('should reject empty personId', () => {
      setup();
      expect(() => store.upsert('group1', '', 'Alice', 'Notes')).toThrow('Invalid personId: cannot be empty');
    });

    it('should reject notes exceeding token limit', () => {
      setup();
      const longNotes = 'a'.repeat(DOSSIER_TOKEN_LIMIT * 4 + 1);
      expect(() => store.upsert('group1', 'person1', 'Alice', longNotes)).toThrow('exceeds token limit');
    });

    it('should allow notes at exactly the token limit', () => {
      setup();
      const exactNotes = 'a'.repeat(DOSSIER_TOKEN_LIMIT * 4);
      const dossier = store.upsert('group1', 'person1', 'Alice', exactNotes);
      expect(dossier.notes).toBe(exactNotes);
    });

    it('should preserve createdAt on update but change updatedAt', async () => {
      setup();
      const first = store.upsert('group1', 'person1', 'Alice', 'V1');
      await new Promise(resolve => setTimeout(resolve, 20));
      const second = store.upsert('group1', 'person1', 'Alice', 'V2');
      expect(second.createdAt).toBe(first.createdAt);
      expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
    });
  });

  describe('get', () => {
    it('should return dossier for existing person', () => {
      setup();
      store.upsert('group1', 'person1', 'Alice', 'Notes');
      const dossier = store.get('group1', 'person1');
      expect(dossier).not.toBeNull();
      expect(dossier?.displayName).toBe('Alice');
      expect(dossier?.notes).toBe('Notes');
    });

    it('should return null for non-existent person', () => {
      setup();
      const dossier = store.get('group1', 'nobody');
      expect(dossier).toBeNull();
    });
  });

  describe('getByGroup', () => {
    it('should return all dossiers for a group', () => {
      setup();
      store.upsert('group1', 'person1', 'Alice', 'Notes A');
      store.upsert('group1', 'person2', 'Bob', 'Notes B');
      const dossiers = store.getByGroup('group1');
      expect(dossiers).toHaveLength(2);
    });

    it('should not return dossiers from other groups', () => {
      setup();
      store.upsert('group1', 'person1', 'Alice', 'Notes A');
      store.upsert('group2', 'person2', 'Bob', 'Notes B');
      const dossiers = store.getByGroup('group1');
      expect(dossiers).toHaveLength(1);
      expect(dossiers[0].displayName).toBe('Alice');
    });

    it('should return empty array when none exist', () => {
      setup();
      const dossiers = store.getByGroup('group1');
      expect(dossiers).toEqual([]);
    });

    it('should return ordered by displayName ASC', () => {
      setup();
      store.upsert('group1', 'person3', 'Charlie', 'Notes C');
      store.upsert('group1', 'person1', 'Alice', 'Notes A');
      store.upsert('group1', 'person2', 'Bob', 'Notes B');
      const dossiers = store.getByGroup('group1');
      expect(dossiers[0].displayName).toBe('Alice');
      expect(dossiers[1].displayName).toBe('Bob');
      expect(dossiers[2].displayName).toBe('Charlie');
    });

    it('should reject empty groupId', () => {
      setup();
      expect(() => store.getByGroup('')).toThrow('Invalid groupId: cannot be empty');
    });
  });

  describe('delete', () => {
    it('should delete an existing dossier', () => {
      setup();
      store.upsert('group1', 'person1', 'Alice', 'Notes');
      const result = store.delete('group1', 'person1');
      expect(result).toBe(true);
      const dossier = store.get('group1', 'person1');
      expect(dossier).toBeNull();
    });

    it('should return false for non-existent dossier', () => {
      setup();
      const result = store.delete('group1', 'nobody');
      expect(result).toBe(false);
    });
  });
});
