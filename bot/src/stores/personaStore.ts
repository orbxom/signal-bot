import type Database from 'better-sqlite3';
import type { DatabaseConnection } from '../db';
import { wrapSqliteError } from '../db';
import type { Persona } from '../types';
import { estimateTokens } from '../utils/tokens';

type PersonaRow = Omit<Persona, 'isDefault'> & { isDefault: number };

function mapPersonaRow(row: PersonaRow): Persona {
  return { ...row, isDefault: row.isDefault === 1 };
}

export const PERSONA_NAME_MAX_LENGTH = 100;
export const PERSONA_DESCRIPTION_TOKEN_LIMIT = 2000;

export const DEFAULT_PERSONA_NAME = 'Default Assistant';
export const DEFAULT_PERSONA_DESCRIPTION =
  'You are a helpful family assistant in a Signal group chat. Be friendly, concise, and helpful. Keep responses under a few sentences unless asked for detail.';

export class PersonaStore {
  private conn: DatabaseConnection;
  private stmts: {
    create: Database.Statement;
    getById: Database.Statement;
    getByName: Database.Statement;
    list: Database.Statement;
    update: Database.Statement;
    delete: Database.Statement;
    getDefault: Database.Statement;
    setActive: Database.Statement;
    getActive: Database.Statement;
    clearActive: Database.Statement;
    clearActiveByPersonaId: Database.Statement;
    seedDefault: Database.Statement;
  };

  constructor(conn: DatabaseConnection) {
    this.conn = conn;
    this.stmts = {
      create: conn.db.prepare(`
        INSERT INTO personas (name, description, tags, isDefault, createdAt, updatedAt)
        VALUES (?, ?, ?, 0, ?, ?)
      `),
      getById: conn.db.prepare(`
        SELECT * FROM personas WHERE id = ?
      `),
      getByName: conn.db.prepare(`
        SELECT * FROM personas WHERE name = ? COLLATE NOCASE
      `),
      list: conn.db.prepare(`
        SELECT * FROM personas ORDER BY name ASC
      `),
      update: conn.db.prepare(`
        UPDATE personas SET name = ?, description = ?, tags = ?, updatedAt = ?
        WHERE id = ?
      `),
      delete: conn.db.prepare(`
        DELETE FROM personas WHERE id = ? AND isDefault = 0
      `),
      getDefault: conn.db.prepare(`
        SELECT * FROM personas WHERE isDefault = 1 LIMIT 1
      `),
      setActive: conn.db.prepare(`
        INSERT INTO active_personas (groupId, personaId, activatedAt)
        VALUES (?, ?, ?)
        ON CONFLICT(groupId) DO UPDATE SET
          personaId = excluded.personaId,
          activatedAt = excluded.activatedAt
      `),
      getActive: conn.db.prepare(`
        SELECT p.* FROM personas p
        INNER JOIN active_personas ap ON ap.personaId = p.id
        WHERE ap.groupId = ?
      `),
      clearActive: conn.db.prepare(`
        DELETE FROM active_personas WHERE groupId = ?
      `),
      clearActiveByPersonaId: conn.db.prepare(`
        DELETE FROM active_personas WHERE personaId = ?
      `),
      seedDefault: conn.db.prepare(`
        INSERT INTO personas (name, description, tags, isDefault, createdAt, updatedAt)
        VALUES (?, ?, ?, 1, ?, ?)
      `),
    };
  }

  seedDefault(): void {
    this.conn.ensureOpen();

    try {
      const existing = this.stmts.getByName.get(DEFAULT_PERSONA_NAME);
      if (!existing) {
        const now = Date.now();
        this.stmts.seedDefault.run(
          DEFAULT_PERSONA_NAME,
          DEFAULT_PERSONA_DESCRIPTION,
          'default,family,helpful',
          now,
          now,
        );
      }
    } catch (error) {
      wrapSqliteError(error, 'seed default persona');
    }
  }

  create(name: string, description: string, tags: string): Persona {
    this.conn.ensureOpen();
    if (!name || name.trim() === '') {
      throw new Error('Invalid name: cannot be empty');
    }
    if (name.length > PERSONA_NAME_MAX_LENGTH) {
      throw new Error(`Invalid name: exceeds maximum length of ${PERSONA_NAME_MAX_LENGTH} characters`);
    }
    if (!description || description.trim() === '') {
      throw new Error('Invalid description: cannot be empty');
    }
    if (estimateTokens(description) > PERSONA_DESCRIPTION_TOKEN_LIMIT) {
      throw new Error(`Description exceeds token limit of ${PERSONA_DESCRIPTION_TOKEN_LIMIT} tokens`);
    }

    try {
      const now = Date.now();
      const result = this.stmts.create.run(name, description, tags, now, now);
      return {
        id: Number(result.lastInsertRowid),
        name,
        description,
        tags,
        isDefault: false,
        createdAt: now,
        updatedAt: now,
      };
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
        throw new Error(`Persona with name "${name}" already exists`);
      }
      wrapSqliteError(error, 'create persona');
    }
  }

  getById(id: number): Persona | null {
    return this.conn.runOp('get persona', () => {
      const row = this.stmts.getById.get(id) as PersonaRow | undefined;
      return row ? mapPersonaRow(row) : null;
    });
  }

  getByName(name: string): Persona | null {
    return this.conn.runOp('get persona by name', () => {
      const row = this.stmts.getByName.get(name) as PersonaRow | undefined;
      return row ? mapPersonaRow(row) : null;
    });
  }

  list(): Persona[] {
    return this.conn.runOp('list personas', () => {
      const rows = this.stmts.list.all() as PersonaRow[];
      return rows.map(mapPersonaRow);
    });
  }

  update(id: number, name: string, description: string, tags: string): boolean {
    this.conn.ensureOpen();
    if (!name || name.trim() === '') {
      throw new Error('Invalid name: cannot be empty');
    }
    if (name.length > PERSONA_NAME_MAX_LENGTH) {
      throw new Error(`Invalid name: exceeds maximum length of ${PERSONA_NAME_MAX_LENGTH} characters`);
    }
    if (!description || description.trim() === '') {
      throw new Error('Invalid description: cannot be empty');
    }
    if (estimateTokens(description) > PERSONA_DESCRIPTION_TOKEN_LIMIT) {
      throw new Error(`Description exceeds token limit of ${PERSONA_DESCRIPTION_TOKEN_LIMIT} tokens`);
    }

    try {
      const now = Date.now();
      const result = this.stmts.update.run(name, description, tags, now, id);
      return result.changes > 0;
    } catch (error) {
      wrapSqliteError(error, 'update persona');
    }
  }

  delete(id: number): boolean {
    try {
      return this.conn.transaction(() => {
        // Clean up any active_personas references first
        this.stmts.clearActiveByPersonaId.run(id);
        const result = this.stmts.delete.run(id);
        return result.changes > 0;
      });
    } catch (error) {
      wrapSqliteError(error, 'delete persona');
    }
  }

  getDefault(): Persona | null {
    return this.conn.runOp('get default persona', () => {
      const row = this.stmts.getDefault.get() as PersonaRow | undefined;
      return row ? mapPersonaRow(row) : null;
    });
  }

  setActive(groupId: string, personaId: number): void {
    this.conn.ensureOpen();
    if (!groupId || groupId.trim() === '') {
      throw new Error('Invalid groupId: cannot be empty');
    }

    try {
      this.stmts.setActive.run(groupId, personaId, Date.now());
    } catch (error) {
      wrapSqliteError(error, 'set active persona');
    }
  }

  getActiveForGroup(groupId: string): Persona | null {
    this.conn.ensureOpen();
    try {
      const row = this.stmts.getActive.get(groupId) as PersonaRow | undefined;
      if (row) return mapPersonaRow(row);
      // Fall back to default persona
      return this.getDefault();
    } catch (error) {
      wrapSqliteError(error, 'get active persona for group');
    }
  }

  clearActive(groupId: string): void {
    this.conn.runOp('clear active persona', () => {
      this.stmts.clearActive.run(groupId);
    });
  }
}
