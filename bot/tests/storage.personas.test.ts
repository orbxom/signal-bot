import { afterEach, describe, expect, it } from 'vitest';
import type { Storage } from '../src/storage';
import { createTestStorage, type TestStorage } from './helpers/testDb';

describe('Storage - Personas (facade delegation)', () => {
  let ts: TestStorage;

  const createStorage = (): Storage => {
    ts = createTestStorage('signal-bot-persona-test-');
    return ts.storage;
  };

  afterEach(() => {
    ts?.cleanup();
  });

  it('should delegate createPersona to personas.create', () => {
    const storage = createStorage();
    const persona = storage.createPersona('Pirate', 'Ye be a pirate captain!', 'fun,pirate');
    expect(persona.name).toBe('Pirate');
    expect(storage.personas.getById(persona.id)?.description).toBe('Ye be a pirate captain!');
  });

  it('should delegate getPersona to personas.getById', () => {
    const storage = createStorage();
    const created = storage.personas.create('Pirate', 'Arr!', '');
    const persona = storage.getPersona(created.id);
    expect(persona?.name).toBe('Pirate');
  });

  it('should delegate listPersonas to personas.list', () => {
    const storage = createStorage();
    storage.personas.create('Pirate', 'Arr!', '');
    const personas = storage.listPersonas();
    expect(personas.length).toBeGreaterThanOrEqual(2); // default + pirate
  });

  it('should delegate setActivePersona and getActivePersonaForGroup', () => {
    const storage = createStorage();
    const pirate = storage.createPersona('Pirate', 'Arr!', '');
    storage.setActivePersona('group1', pirate.id);
    const active = storage.getActivePersonaForGroup('group1');
    expect(active?.name).toBe('Pirate');
  });

  it('should delegate clearActivePersona', () => {
    const storage = createStorage();
    const pirate = storage.createPersona('Pirate', 'Arr!', '');
    storage.setActivePersona('group1', pirate.id);
    storage.clearActivePersona('group1');
    const active = storage.getActivePersonaForGroup('group1');
    expect(active?.isDefault).toBe(true);
  });

  describe('close guard for persona methods', () => {
    it('should throw on createPersona after close', () => {
      const storage = createStorage();
      storage.close();
      expect(() => storage.createPersona('Test', 'Desc', '')).toThrow('Database is closed');
    });

    it('should throw on getPersona after close', () => {
      const storage = createStorage();
      storage.close();
      expect(() => storage.getPersona(1)).toThrow('Database is closed');
    });

    it('should throw on listPersonas after close', () => {
      const storage = createStorage();
      storage.close();
      expect(() => storage.listPersonas()).toThrow('Database is closed');
    });

    it('should throw on updatePersona after close', () => {
      const storage = createStorage();
      storage.close();
      expect(() => storage.updatePersona(1, 'N', 'D', '')).toThrow('Database is closed');
    });

    it('should throw on deletePersona after close', () => {
      const storage = createStorage();
      storage.close();
      expect(() => storage.deletePersona(1)).toThrow('Database is closed');
    });

    it('should throw on setActivePersona after close', () => {
      const storage = createStorage();
      storage.close();
      expect(() => storage.setActivePersona('g1', 1)).toThrow('Database is closed');
    });

    it('should throw on getActivePersonaForGroup after close', () => {
      const storage = createStorage();
      storage.close();
      expect(() => storage.getActivePersonaForGroup('g1')).toThrow('Database is closed');
    });
  });
});
