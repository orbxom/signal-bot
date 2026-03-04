import type Database from 'better-sqlite3';
import type { DatabaseConnection } from '../db';
import { wrapSqliteError } from '../db';
import { estimateTokens } from '../mcpServerBase';
import type { Dossier } from '../types';

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
      if (
        error instanceof Error &&
        (error.message.startsWith('Invalid ') || error.message.startsWith('Notes exceeds'))
      ) {
        throw error;
      }
      wrapSqliteError(error, 'upsert dossier');
    }
  }

  get(groupId: string, personId: string): Dossier | null {
    this.conn.ensureOpen();

    try {
      const row = this.stmts.get.get(groupId, personId) as Dossier | undefined;
      return row ?? null;
    } catch (error) {
      wrapSqliteError(error, 'get dossier');
    }
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

  delete(groupId: string, personId: string): boolean {
    this.conn.ensureOpen();

    try {
      const result = this.stmts.delete.run(groupId, personId);
      return result.changes > 0;
    } catch (error) {
      wrapSqliteError(error, 'delete dossier');
    }
  }
}
