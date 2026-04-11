import type Database from 'better-sqlite3';
import type { DatabaseConnection } from '../db';
import { wrapSqliteError } from '../db';
import type { Dossier } from '../types';
import { estimateTokens } from '../utils/tokens';

export const DOSSIER_TOKEN_LIMIT = 1000;

export class DossierStore {
  private conn: DatabaseConnection;
  private stmts: {
    upsert: Database.Statement;
    get: Database.Statement;
    getByGroup: Database.Statement;
    delete: Database.Statement;
  };

  constructor(conn: DatabaseConnection) {
    this.conn = conn;
    this.stmts = {
      upsert: conn.db.prepare(`
        INSERT INTO dossiers (groupId, personId, displayName, notes, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(groupId, personId) DO UPDATE SET
          displayName = excluded.displayName,
          notes = excluded.notes,
          updatedAt = excluded.updatedAt
        RETURNING *
      `),
      get: conn.db.prepare(`
        SELECT * FROM dossiers WHERE groupId = ? AND personId = ?
      `),
      getByGroup: conn.db.prepare(`
        SELECT * FROM dossiers WHERE groupId = ? ORDER BY displayName ASC
      `),
      delete: conn.db.prepare(`
        DELETE FROM dossiers WHERE groupId = ? AND personId = ?
      `),
    };
  }

  upsert(groupId: string, personId: string, displayName: string, notes: string): Dossier {
    this.conn.ensureOpen();
    if (!groupId || groupId.trim() === '') {
      throw new Error('Invalid groupId: cannot be empty');
    }
    if (!personId || personId.trim() === '') {
      throw new Error('Invalid personId: cannot be empty');
    }
    if (estimateTokens(notes) > DOSSIER_TOKEN_LIMIT) {
      throw new Error(`Notes exceeds token limit of ${DOSSIER_TOKEN_LIMIT} tokens`);
    }

    try {
      const now = Date.now();
      const row = this.stmts.upsert.get(groupId, personId, displayName, notes, now, now) as Dossier;
      return row;
    } catch (error) {
      wrapSqliteError(error, 'upsert dossier');
    }
  }

  get(groupId: string, personId: string): Dossier | null {
    return this.conn.runOp('get dossier', () => {
      const row = this.stmts.get.get(groupId, personId) as Dossier | undefined;
      return row ?? null;
    });
  }

  getByGroup(groupId: string): Dossier[] {
    this.conn.ensureOpen();
    if (!groupId || groupId.trim() === '') {
      throw new Error('Invalid groupId: cannot be empty');
    }

    try {
      return this.stmts.getByGroup.all(groupId) as Dossier[];
    } catch (error) {
      wrapSqliteError(error, 'get dossiers by group');
    }
  }

  listAll(filters?: { groupId?: string; limit?: number; offset?: number }): Dossier[] {
    return this.conn.runOp('list all dossiers', () => {
      const limit = Math.min(filters?.limit ?? 50, 200);
      const offset = filters?.offset ?? 0;
      if (filters?.groupId) {
        return this.conn.db
          .prepare('SELECT * FROM dossiers WHERE groupId = ? ORDER BY displayName LIMIT ? OFFSET ?')
          .all(filters.groupId, limit, offset) as Dossier[];
      }
      return this.conn.db
        .prepare('SELECT * FROM dossiers ORDER BY displayName LIMIT ? OFFSET ?')
        .all(limit, offset) as Dossier[];
    });
  }

  delete(groupId: string, personId: string): boolean {
    return this.conn.runOp('delete dossier', () => {
      const result = this.stmts.delete.run(groupId, personId);
      return result.changes > 0;
    });
  }
}
