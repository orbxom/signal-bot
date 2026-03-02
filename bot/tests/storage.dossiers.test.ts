import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DOSSIER_TOKEN_LIMIT, Storage } from '../src/storage';

describe('Storage - Dossiers', () => {
  let testDir: string;
  let storage: Storage;

  const createStorage = () => {
    testDir = mkdtempSync(join(tmpdir(), 'signal-bot-dossier-test-'));
    storage = new Storage(join(testDir, 'test.db'));
    return storage;
  };

  afterEach(() => {
    storage?.close();
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('upsertDossier', () => {
    it('should create a new dossier', () => {
      createStorage();
      const dossier = storage.upsertDossier('group1', 'person1', 'Alice', 'Likes coffee');
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
      createStorage();
      const first = storage.upsertDossier('group1', 'person1', 'Alice', 'Original notes');
      const second = storage.upsertDossier('group1', 'person1', 'Alice B', 'Updated notes');
      expect(second.id).toBe(first.id);
      expect(second.displayName).toBe('Alice B');
      expect(second.notes).toBe('Updated notes');
    });

    it('should reject empty groupId', () => {
      createStorage();
      expect(() => storage.upsertDossier('', 'person1', 'Alice', 'Notes')).toThrow('Invalid groupId: cannot be empty');
    });

    it('should reject empty personId', () => {
      createStorage();
      expect(() => storage.upsertDossier('group1', '', 'Alice', 'Notes')).toThrow('Invalid personId: cannot be empty');
    });

    it('should reject notes exceeding token limit', () => {
      createStorage();
      const longNotes = 'a'.repeat(DOSSIER_TOKEN_LIMIT * 4 + 1);
      expect(() => storage.upsertDossier('group1', 'person1', 'Alice', longNotes)).toThrow('exceeds token limit');
    });

    it('should allow notes at exactly the token limit', () => {
      createStorage();
      const exactNotes = 'a'.repeat(DOSSIER_TOKEN_LIMIT * 4);
      const dossier = storage.upsertDossier('group1', 'person1', 'Alice', exactNotes);
      expect(dossier.notes).toBe(exactNotes);
    });

    it('should preserve createdAt on update but change updatedAt', async () => {
      createStorage();
      const first = storage.upsertDossier('group1', 'person1', 'Alice', 'V1');
      // Small delay to ensure updatedAt differs
      await new Promise(resolve => setTimeout(resolve, 20));
      const second = storage.upsertDossier('group1', 'person1', 'Alice', 'V2');
      expect(second.createdAt).toBe(first.createdAt);
      expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
    });
  });

  describe('getDossier', () => {
    it('should return dossier for existing person', () => {
      createStorage();
      storage.upsertDossier('group1', 'person1', 'Alice', 'Notes');
      const dossier = storage.getDossier('group1', 'person1');
      expect(dossier).not.toBeNull();
      expect(dossier?.displayName).toBe('Alice');
      expect(dossier?.notes).toBe('Notes');
    });

    it('should return null for non-existent person', () => {
      createStorage();
      const dossier = storage.getDossier('group1', 'nobody');
      expect(dossier).toBeNull();
    });
  });

  describe('getDossiersByGroup', () => {
    it('should return all dossiers for a group', () => {
      createStorage();
      storage.upsertDossier('group1', 'person1', 'Alice', 'Notes A');
      storage.upsertDossier('group1', 'person2', 'Bob', 'Notes B');
      const dossiers = storage.getDossiersByGroup('group1');
      expect(dossiers).toHaveLength(2);
    });

    it('should not return dossiers from other groups', () => {
      createStorage();
      storage.upsertDossier('group1', 'person1', 'Alice', 'Notes A');
      storage.upsertDossier('group2', 'person2', 'Bob', 'Notes B');
      const dossiers = storage.getDossiersByGroup('group1');
      expect(dossiers).toHaveLength(1);
      expect(dossiers[0].displayName).toBe('Alice');
    });

    it('should return empty array when none exist', () => {
      createStorage();
      const dossiers = storage.getDossiersByGroup('group1');
      expect(dossiers).toEqual([]);
    });

    it('should return ordered by displayName ASC', () => {
      createStorage();
      storage.upsertDossier('group1', 'person3', 'Charlie', 'Notes C');
      storage.upsertDossier('group1', 'person1', 'Alice', 'Notes A');
      storage.upsertDossier('group1', 'person2', 'Bob', 'Notes B');
      const dossiers = storage.getDossiersByGroup('group1');
      expect(dossiers[0].displayName).toBe('Alice');
      expect(dossiers[1].displayName).toBe('Bob');
      expect(dossiers[2].displayName).toBe('Charlie');
    });

    it('should reject empty groupId', () => {
      createStorage();
      expect(() => storage.getDossiersByGroup('')).toThrow('Invalid groupId: cannot be empty');
    });
  });

  describe('deleteDossier', () => {
    it('should delete an existing dossier', () => {
      createStorage();
      storage.upsertDossier('group1', 'person1', 'Alice', 'Notes');
      const result = storage.deleteDossier('group1', 'person1');
      expect(result).toBe(true);
      // Verify it's gone
      const dossier = storage.getDossier('group1', 'person1');
      expect(dossier).toBeNull();
    });

    it('should return false for non-existent dossier', () => {
      createStorage();
      const result = storage.deleteDossier('group1', 'nobody');
      expect(result).toBe(false);
    });
  });

  describe('close guard for dossier methods', () => {
    it('should throw on upsertDossier after close', () => {
      createStorage();
      storage.close();
      expect(() => storage.upsertDossier('g1', 'p1', 'Alice', 'Notes')).toThrow('Database is closed');
    });

    it('should throw on getDossier after close', () => {
      createStorage();
      storage.close();
      expect(() => storage.getDossier('g1', 'p1')).toThrow('Database is closed');
    });

    it('should throw on getDossiersByGroup after close', () => {
      createStorage();
      storage.close();
      expect(() => storage.getDossiersByGroup('g1')).toThrow('Database is closed');
    });

    it('should throw on deleteDossier after close', () => {
      createStorage();
      storage.close();
      expect(() => storage.deleteDossier('g1', 'p1')).toThrow('Database is closed');
    });
  });
});
