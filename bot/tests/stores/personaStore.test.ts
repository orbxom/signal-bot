import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseConnection } from '../../src/db';
import { PERSONA_DESCRIPTION_TOKEN_LIMIT, PersonaStore } from '../../src/stores/personaStore';

describe('PersonaStore', () => {
  let testDir: string;
  let conn: DatabaseConnection;
  let store: PersonaStore;

  const setup = () => {
    testDir = mkdtempSync(join(tmpdir(), 'signal-bot-persona-store-test-'));
    conn = new DatabaseConnection(join(testDir, 'test.db'));
    store = new PersonaStore(conn);
    return store;
  };

  afterEach(() => {
    conn?.close();
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('seedDefault', () => {
    it('should seed a default persona on initialization', () => {
      setup();
      store.seedDefault();
      const defaultPersona = store.getDefault();
      expect(defaultPersona).not.toBeNull();
      expect(defaultPersona?.name).toBe('Default Assistant');
      expect(defaultPersona?.isDefault).toBe(1);
      expect(defaultPersona?.description).toContain('helpful family assistant');
    });

    it('should not create duplicate default on re-seed', () => {
      setup();
      store.seedDefault();
      store.seedDefault();
      const personas = store.list();
      const defaults = personas.filter(p => p.name === 'Default Assistant');
      expect(defaults).toHaveLength(1);
    });
  });

  describe('create', () => {
    it('should create a persona with correct fields', () => {
      setup();
      const persona = store.create('Pirate', 'Ye be a pirate captain!', 'fun,pirate');
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
      setup();
      expect(() => store.create('', 'A description', '')).toThrow('Invalid name: cannot be empty');
    });

    it('should reject empty description', () => {
      setup();
      expect(() => store.create('Test', '', '')).toThrow('Invalid description: cannot be empty');
    });

    it('should reject duplicate name (case-insensitive)', () => {
      setup();
      store.create('Pirate', 'Description 1', '');
      expect(() => store.create('pirate', 'Description 2', '')).toThrow('already exists');
    });

    it('should reject description exceeding token limit', () => {
      setup();
      const longDesc = 'a'.repeat(PERSONA_DESCRIPTION_TOKEN_LIMIT * 4 + 1);
      expect(() => store.create('Test', longDesc, '')).toThrow('exceeds token limit');
    });

    it('should allow description at exactly the token limit', () => {
      setup();
      const exactDesc = 'a'.repeat(PERSONA_DESCRIPTION_TOKEN_LIMIT * 4);
      const persona = store.create('Test', exactDesc, '');
      expect(persona.description).toBe(exactDesc);
    });

    it('should default tags to empty string', () => {
      setup();
      const persona = store.create('Test', 'A description', '');
      expect(persona.tags).toBe('');
    });
  });

  describe('getById', () => {
    it('should return persona by ID', () => {
      setup();
      const created = store.create('Pirate', 'Arr!', '');
      const persona = store.getById(created.id);
      expect(persona).not.toBeNull();
      expect(persona?.name).toBe('Pirate');
    });

    it('should return null for non-existent ID', () => {
      setup();
      expect(store.getById(999)).toBeNull();
    });
  });

  describe('getByName', () => {
    it('should return persona by name (case-insensitive)', () => {
      setup();
      store.create('Pirate', 'Arr!', '');
      const persona = store.getByName('pirate');
      expect(persona).not.toBeNull();
      expect(persona?.name).toBe('Pirate');
    });

    it('should return null for non-existent name', () => {
      setup();
      expect(store.getByName('nobody')).toBeNull();
    });
  });

  describe('list', () => {
    it('should return all personas ordered by name', () => {
      setup();
      store.seedDefault();
      store.create('Zen Master', 'Be calm.', '');
      store.create('Pirate', 'Arr!', '');
      const personas = store.list();
      expect(personas.length).toBeGreaterThanOrEqual(3);
      const names = personas.map(p => p.name);
      expect(names).toEqual([...names].sort());
    });

    it('should include the seeded default persona', () => {
      setup();
      store.seedDefault();
      const personas = store.list();
      expect(personas.some(p => p.isDefault === 1)).toBe(true);
    });
  });

  describe('update', () => {
    it('should update name, description, and tags', () => {
      setup();
      const created = store.create('Pirate', 'Arr!', 'fun');
      const result = store.update(created.id, 'Captain Pirate', 'Avast!', 'fun,captain');
      expect(result).toBe(true);
      const updated = store.getById(created.id);
      expect(updated?.name).toBe('Captain Pirate');
      expect(updated?.description).toBe('Avast!');
      expect(updated?.tags).toBe('fun,captain');
    });

    it('should reject empty name', () => {
      setup();
      const created = store.create('Pirate', 'Arr!', '');
      expect(() => store.update(created.id, '', 'Arr!', '')).toThrow('Invalid name: cannot be empty');
    });

    it('should reject empty description', () => {
      setup();
      const created = store.create('Pirate', 'Arr!', '');
      expect(() => store.update(created.id, 'Pirate', '', '')).toThrow('Invalid description: cannot be empty');
    });

    it('should reject description exceeding token limit', () => {
      setup();
      const created = store.create('Pirate', 'Arr!', '');
      const longDesc = 'a'.repeat(PERSONA_DESCRIPTION_TOKEN_LIMIT * 4 + 1);
      expect(() => store.update(created.id, 'Pirate', longDesc, '')).toThrow('exceeds token limit');
    });

    it('should return false for non-existent ID', () => {
      setup();
      const result = store.update(999, 'Test', 'Desc', '');
      expect(result).toBe(false);
    });
  });

  describe('delete', () => {
    it('should delete an existing persona', () => {
      setup();
      const created = store.create('Pirate', 'Arr!', '');
      const result = store.delete(created.id);
      expect(result).toBe(true);
      expect(store.getById(created.id)).toBeNull();
    });

    it('should return false for non-existent ID', () => {
      setup();
      expect(store.delete(999)).toBe(false);
    });

    it('should refuse to delete default persona', () => {
      setup();
      store.seedDefault();
      const defaultPersona = store.getDefault();
      expect(defaultPersona).not.toBeNull();
      const result = store.delete(defaultPersona?.id);
      expect(result).toBe(false);
      expect(store.getDefault()).not.toBeNull();
    });

    it('should clean up active_personas references when deleted', () => {
      setup();
      store.seedDefault();
      const created = store.create('Pirate', 'Arr!', '');
      store.setActive('group1', created.id);
      store.delete(created.id);
      const active = store.getActiveForGroup('group1');
      expect(active?.isDefault).toBe(1);
    });
  });

  describe('getDefault', () => {
    it('should return the seeded default persona', () => {
      setup();
      store.seedDefault();
      const persona = store.getDefault();
      expect(persona).not.toBeNull();
      expect(persona?.isDefault).toBe(1);
      expect(persona?.name).toBe('Default Assistant');
    });
  });

  describe('setActive', () => {
    it('should set active persona for a group', () => {
      setup();
      store.seedDefault();
      const created = store.create('Pirate', 'Arr!', '');
      store.setActive('group1', created.id);
      const active = store.getActiveForGroup('group1');
      expect(active).not.toBeNull();
      expect(active?.name).toBe('Pirate');
    });

    it('should upsert on conflict (same group)', () => {
      setup();
      store.seedDefault();
      const pirate = store.create('Pirate', 'Arr!', '');
      const zen = store.create('Zen', 'Peace.', '');
      store.setActive('group1', pirate.id);
      store.setActive('group1', zen.id);
      const active = store.getActiveForGroup('group1');
      expect(active?.name).toBe('Zen');
    });

    it('should reject empty groupId', () => {
      setup();
      const created = store.create('Pirate', 'Arr!', '');
      expect(() => store.setActive('', created.id)).toThrow('Invalid groupId: cannot be empty');
    });
  });

  describe('getActiveForGroup', () => {
    it('should return active persona for group', () => {
      setup();
      store.seedDefault();
      const created = store.create('Pirate', 'Arr!', '');
      store.setActive('group1', created.id);
      const active = store.getActiveForGroup('group1');
      expect(active?.name).toBe('Pirate');
    });

    it('should return default when no active persona set', () => {
      setup();
      store.seedDefault();
      const active = store.getActiveForGroup('group1');
      expect(active).not.toBeNull();
      expect(active?.isDefault).toBe(1);
    });

    it('should support different personas per group', () => {
      setup();
      store.seedDefault();
      const pirate = store.create('Pirate', 'Arr!', '');
      const zen = store.create('Zen', 'Peace.', '');
      store.setActive('group1', pirate.id);
      store.setActive('group2', zen.id);
      expect(store.getActiveForGroup('group1')?.name).toBe('Pirate');
      expect(store.getActiveForGroup('group2')?.name).toBe('Zen');
    });
  });

  describe('clearActive', () => {
    it('should clear active persona, reverting to default', () => {
      setup();
      store.seedDefault();
      const created = store.create('Pirate', 'Arr!', '');
      store.setActive('group1', created.id);
      store.clearActive('group1');
      const active = store.getActiveForGroup('group1');
      expect(active?.isDefault).toBe(1);
    });

    it('should be a no-op if no active persona set', () => {
      setup();
      expect(() => store.clearActive('group1')).not.toThrow();
    });
  });
});
