import { afterEach, describe, expect, it } from 'vitest';
import type { Storage } from '../src/storage';
import { createTestStorage, type TestStorage } from './helpers/testDb';

describe('Storage - Dossiers (facade delegation)', () => {
  let ts: TestStorage;

  const createStorage = (): Storage => {
    ts = createTestStorage('signal-bot-dossier-test-');
    return ts.storage;
  };

  afterEach(() => {
    ts?.cleanup();
  });

  it('should delegate upsertDossier to dossiers.upsert', () => {
    const storage = createStorage();
    const dossier = storage.upsertDossier('group1', 'person1', 'Alice', 'Likes coffee');
    expect(dossier.displayName).toBe('Alice');
    expect(storage.dossiers.get('group1', 'person1')?.notes).toBe('Likes coffee');
  });

  it('should delegate getDossier to dossiers.get', () => {
    const storage = createStorage();
    storage.dossiers.upsert('group1', 'person1', 'Alice', 'Notes');
    const dossier = storage.getDossier('group1', 'person1');
    expect(dossier?.displayName).toBe('Alice');
  });

  it('should delegate getDossiersByGroup to dossiers.getByGroup', () => {
    const storage = createStorage();
    storage.dossiers.upsert('group1', 'person1', 'Alice', 'Notes A');
    storage.dossiers.upsert('group1', 'person2', 'Bob', 'Notes B');
    const dossiers = storage.getDossiersByGroup('group1');
    expect(dossiers).toHaveLength(2);
  });

  it('should delegate deleteDossier to dossiers.delete', () => {
    const storage = createStorage();
    storage.dossiers.upsert('group1', 'person1', 'Alice', 'Notes');
    const result = storage.deleteDossier('group1', 'person1');
    expect(result).toBe(true);
    expect(storage.dossiers.get('group1', 'person1')).toBeNull();
  });

  describe('close guard for dossier methods', () => {
    it('should throw on upsertDossier after close', () => {
      const storage = createStorage();
      storage.close();
      expect(() => storage.upsertDossier('g1', 'p1', 'Alice', 'Notes')).toThrow('Database is closed');
    });

    it('should throw on getDossier after close', () => {
      const storage = createStorage();
      storage.close();
      expect(() => storage.getDossier('g1', 'p1')).toThrow('Database is closed');
    });

    it('should throw on getDossiersByGroup after close', () => {
      const storage = createStorage();
      storage.close();
      expect(() => storage.getDossiersByGroup('g1')).toThrow('Database is closed');
    });

    it('should throw on deleteDossier after close', () => {
      const storage = createStorage();
      storage.close();
      expect(() => storage.deleteDossier('g1', 'p1')).toThrow('Database is closed');
    });
  });
});
