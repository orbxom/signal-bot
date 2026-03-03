import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PERSONA_DESCRIPTION_TOKEN_LIMIT, Storage } from '../src/storage';

describe('Storage - Personas', () => {
  let testDir: string;
  let storage: Storage;

  const createStorage = () => {
    testDir = mkdtempSync(join(tmpdir(), 'signal-bot-persona-test-'));
    storage = new Storage(join(testDir, 'test.db'));
    return storage;
  };

  afterEach(() => {
    storage?.close();
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('default persona seed', () => {
    it('should seed a default persona on initialization', () => {
      createStorage();
      const defaultPersona = storage.getDefaultPersona();
      expect(defaultPersona).not.toBeNull();
      expect(defaultPersona?.name).toBe('Default Assistant');
      expect(defaultPersona?.isDefault).toBe(1);
      expect(defaultPersona?.description).toContain('helpful family assistant');
    });

    it('should not create duplicate default on re-open', () => {
      createStorage();
      storage.close();
      storage = new Storage(join(testDir, 'test.db'));
      const personas = storage.listPersonas();
      const defaults = personas.filter(p => p.name === 'Default Assistant');
      expect(defaults).toHaveLength(1);
    });
  });

  describe('createPersona', () => {
    it('should create a persona with correct fields', () => {
      createStorage();
      const persona = storage.createPersona('Pirate', 'Ye be a pirate captain!', 'fun,pirate');
      expect(persona).toMatchObject({
        name: 'Pirate',
        description: 'Ye be a pirate captain!',
        tags: 'fun,pirate',
        isDefault: 0,
      });
      expect(persona.id).toBeGreaterThan(0);
      expect(persona.createdAt).toBeGreaterThan(0);
      expect(persona.updatedAt).toBeGreaterThan(0);
    });

    it('should reject empty name', () => {
      createStorage();
      expect(() => storage.createPersona('', 'A description', '')).toThrow('Invalid name: cannot be empty');
    });

    it('should reject empty description', () => {
      createStorage();
      expect(() => storage.createPersona('Test', '', '')).toThrow('Invalid description: cannot be empty');
    });

    it('should reject duplicate name (case-insensitive)', () => {
      createStorage();
      storage.createPersona('Pirate', 'Description 1', '');
      expect(() => storage.createPersona('pirate', 'Description 2', '')).toThrow('already exists');
    });

    it('should reject description exceeding token limit', () => {
      createStorage();
      const longDesc = 'a'.repeat(PERSONA_DESCRIPTION_TOKEN_LIMIT * 4 + 1);
      expect(() => storage.createPersona('Test', longDesc, '')).toThrow('exceeds token limit');
    });

    it('should allow description at exactly the token limit', () => {
      createStorage();
      const exactDesc = 'a'.repeat(PERSONA_DESCRIPTION_TOKEN_LIMIT * 4);
      const persona = storage.createPersona('Test', exactDesc, '');
      expect(persona.description).toBe(exactDesc);
    });

    it('should default tags to empty string', () => {
      createStorage();
      const persona = storage.createPersona('Test', 'A description', '');
      expect(persona.tags).toBe('');
    });
  });

  describe('getPersona', () => {
    it('should return persona by ID', () => {
      createStorage();
      const created = storage.createPersona('Pirate', 'Arr!', '');
      const persona = storage.getPersona(created.id);
      expect(persona).not.toBeNull();
      expect(persona?.name).toBe('Pirate');
    });

    it('should return null for non-existent ID', () => {
      createStorage();
      expect(storage.getPersona(999)).toBeNull();
    });
  });

  describe('getPersonaByName', () => {
    it('should return persona by name (case-insensitive)', () => {
      createStorage();
      storage.createPersona('Pirate', 'Arr!', '');
      const persona = storage.getPersonaByName('pirate');
      expect(persona).not.toBeNull();
      expect(persona?.name).toBe('Pirate');
    });

    it('should return null for non-existent name', () => {
      createStorage();
      expect(storage.getPersonaByName('nobody')).toBeNull();
    });
  });

  describe('listPersonas', () => {
    it('should return all personas ordered by name', () => {
      createStorage();
      storage.createPersona('Zen Master', 'Be calm.', '');
      storage.createPersona('Pirate', 'Arr!', '');
      const personas = storage.listPersonas();
      expect(personas.length).toBeGreaterThanOrEqual(3); // default + 2
      // Verify ordering (Default Assistant, Pirate, Zen Master)
      const names = personas.map(p => p.name);
      expect(names).toEqual([...names].sort());
    });

    it('should include the seeded default persona', () => {
      createStorage();
      const personas = storage.listPersonas();
      expect(personas.some(p => p.isDefault === 1)).toBe(true);
    });
  });

  describe('updatePersona', () => {
    it('should update name, description, and tags', () => {
      createStorage();
      const created = storage.createPersona('Pirate', 'Arr!', 'fun');
      const result = storage.updatePersona(created.id, 'Captain Pirate', 'Avast!', 'fun,captain');
      expect(result).toBe(true);
      const updated = storage.getPersona(created.id);
      expect(updated?.name).toBe('Captain Pirate');
      expect(updated?.description).toBe('Avast!');
      expect(updated?.tags).toBe('fun,captain');
    });

    it('should reject empty name', () => {
      createStorage();
      const created = storage.createPersona('Pirate', 'Arr!', '');
      expect(() => storage.updatePersona(created.id, '', 'Arr!', '')).toThrow('Invalid name: cannot be empty');
    });

    it('should reject empty description', () => {
      createStorage();
      const created = storage.createPersona('Pirate', 'Arr!', '');
      expect(() => storage.updatePersona(created.id, 'Pirate', '', '')).toThrow('Invalid description: cannot be empty');
    });

    it('should reject description exceeding token limit', () => {
      createStorage();
      const created = storage.createPersona('Pirate', 'Arr!', '');
      const longDesc = 'a'.repeat(PERSONA_DESCRIPTION_TOKEN_LIMIT * 4 + 1);
      expect(() => storage.updatePersona(created.id, 'Pirate', longDesc, '')).toThrow('exceeds token limit');
    });

    it('should return false for non-existent ID', () => {
      createStorage();
      const result = storage.updatePersona(999, 'Test', 'Desc', '');
      expect(result).toBe(false);
    });
  });

  describe('deletePersona', () => {
    it('should delete an existing persona', () => {
      createStorage();
      const created = storage.createPersona('Pirate', 'Arr!', '');
      const result = storage.deletePersona(created.id);
      expect(result).toBe(true);
      expect(storage.getPersona(created.id)).toBeNull();
    });

    it('should return false for non-existent ID', () => {
      createStorage();
      expect(storage.deletePersona(999)).toBe(false);
    });

    it('should refuse to delete default persona', () => {
      createStorage();
      const defaultPersona = storage.getDefaultPersona();
      expect(defaultPersona).not.toBeNull();
      const result = storage.deletePersona(defaultPersona?.id);
      expect(result).toBe(false);
      // Still exists
      expect(storage.getDefaultPersona()).not.toBeNull();
    });

    it('should clean up active_personas references when deleted', () => {
      createStorage();
      const created = storage.createPersona('Pirate', 'Arr!', '');
      storage.setActivePersona('group1', created.id);
      storage.deletePersona(created.id);
      // Group should fall back to default
      const active = storage.getActivePersonaForGroup('group1');
      expect(active?.isDefault).toBe(1);
    });
  });

  describe('getDefaultPersona', () => {
    it('should return the seeded default persona', () => {
      createStorage();
      const persona = storage.getDefaultPersona();
      expect(persona).not.toBeNull();
      expect(persona?.isDefault).toBe(1);
      expect(persona?.name).toBe('Default Assistant');
    });
  });

  describe('setActivePersona', () => {
    it('should set active persona for a group', () => {
      createStorage();
      const created = storage.createPersona('Pirate', 'Arr!', '');
      storage.setActivePersona('group1', created.id);
      const active = storage.getActivePersonaForGroup('group1');
      expect(active).not.toBeNull();
      expect(active?.name).toBe('Pirate');
    });

    it('should upsert on conflict (same group)', () => {
      createStorage();
      const pirate = storage.createPersona('Pirate', 'Arr!', '');
      const zen = storage.createPersona('Zen', 'Peace.', '');
      storage.setActivePersona('group1', pirate.id);
      storage.setActivePersona('group1', zen.id);
      const active = storage.getActivePersonaForGroup('group1');
      expect(active?.name).toBe('Zen');
    });

    it('should reject empty groupId', () => {
      createStorage();
      const created = storage.createPersona('Pirate', 'Arr!', '');
      expect(() => storage.setActivePersona('', created.id)).toThrow('Invalid groupId: cannot be empty');
    });
  });

  describe('getActivePersonaForGroup', () => {
    it('should return active persona for group', () => {
      createStorage();
      const created = storage.createPersona('Pirate', 'Arr!', '');
      storage.setActivePersona('group1', created.id);
      const active = storage.getActivePersonaForGroup('group1');
      expect(active?.name).toBe('Pirate');
    });

    it('should return default when no active persona set', () => {
      createStorage();
      const active = storage.getActivePersonaForGroup('group1');
      expect(active).not.toBeNull();
      expect(active?.isDefault).toBe(1);
    });

    it('should support different personas per group', () => {
      createStorage();
      const pirate = storage.createPersona('Pirate', 'Arr!', '');
      const zen = storage.createPersona('Zen', 'Peace.', '');
      storage.setActivePersona('group1', pirate.id);
      storage.setActivePersona('group2', zen.id);
      expect(storage.getActivePersonaForGroup('group1')?.name).toBe('Pirate');
      expect(storage.getActivePersonaForGroup('group2')?.name).toBe('Zen');
    });
  });

  describe('clearActivePersona', () => {
    it('should clear active persona, reverting to default', () => {
      createStorage();
      const created = storage.createPersona('Pirate', 'Arr!', '');
      storage.setActivePersona('group1', created.id);
      storage.clearActivePersona('group1');
      const active = storage.getActivePersonaForGroup('group1');
      expect(active?.isDefault).toBe(1);
    });

    it('should be a no-op if no active persona set', () => {
      createStorage();
      expect(() => storage.clearActivePersona('group1')).not.toThrow();
    });
  });

  describe('close guard for persona methods', () => {
    it('should throw on createPersona after close', () => {
      createStorage();
      storage.close();
      expect(() => storage.createPersona('Test', 'Desc', '')).toThrow('Database is closed');
    });

    it('should throw on getPersona after close', () => {
      createStorage();
      storage.close();
      expect(() => storage.getPersona(1)).toThrow('Database is closed');
    });

    it('should throw on listPersonas after close', () => {
      createStorage();
      storage.close();
      expect(() => storage.listPersonas()).toThrow('Database is closed');
    });

    it('should throw on updatePersona after close', () => {
      createStorage();
      storage.close();
      expect(() => storage.updatePersona(1, 'N', 'D', '')).toThrow('Database is closed');
    });

    it('should throw on deletePersona after close', () => {
      createStorage();
      storage.close();
      expect(() => storage.deletePersona(1)).toThrow('Database is closed');
    });

    it('should throw on setActivePersona after close', () => {
      createStorage();
      storage.close();
      expect(() => storage.setActivePersona('g1', 1)).toThrow('Database is closed');
    });

    it('should throw on getActivePersonaForGroup after close', () => {
      createStorage();
      storage.close();
      expect(() => storage.getActivePersonaForGroup('g1')).toThrow('Database is closed');
    });
  });
});
