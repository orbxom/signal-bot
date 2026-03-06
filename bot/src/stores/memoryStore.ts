import type Database from 'better-sqlite3';
import type { DatabaseConnection } from '../db';
import { wrapSqliteError } from '../db';
import { estimateTokens } from '../mcp/result';
import type { Memory } from '../types';

export const MEMORY_TOKEN_LIMIT = 500;

export class MemoryStore {
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
        INSERT INTO memories (groupId, topic, content, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(groupId, topic) DO UPDATE SET
          content = excluded.content,
          updatedAt = excluded.updatedAt
        RETURNING *
      `),
      get: conn.db.prepare(`
        SELECT * FROM memories WHERE groupId = ? AND topic = ?
      `),
      getByGroup: conn.db.prepare(`
        SELECT * FROM memories WHERE groupId = ? ORDER BY topic ASC
      `),
      delete: conn.db.prepare(`
        DELETE FROM memories WHERE groupId = ? AND topic = ?
      `),
    };
  }

  upsert(groupId: string, topic: string, content: string): Memory {
    this.conn.ensureOpen();
    if (!groupId || groupId.trim() === '') {
      throw new Error('Invalid groupId: cannot be empty');
    }
    if (!topic || topic.trim() === '') {
      throw new Error('Invalid topic: cannot be empty');
    }
    if (estimateTokens(content) > MEMORY_TOKEN_LIMIT) {
      throw new Error(`Content exceeds token limit of ${MEMORY_TOKEN_LIMIT} tokens`);
    }

    try {
      const now = Date.now();
      const row = this.stmts.upsert.get(groupId, topic, content, now, now) as Memory;
      return row;
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.startsWith('Invalid ') || error.message.startsWith('Content exceeds'))
      ) {
        throw error;
      }
      wrapSqliteError(error, 'upsert memory');
    }
  }

  get(groupId: string, topic: string): Memory | null {
    this.conn.ensureOpen();

    try {
      const row = this.stmts.get.get(groupId, topic) as Memory | undefined;
      return row ?? null;
    } catch (error) {
      wrapSqliteError(error, 'get memory');
    }
  }

  getByGroup(groupId: string): Memory[] {
    this.conn.ensureOpen();
    if (!groupId || groupId.trim() === '') {
      throw new Error('Invalid groupId: cannot be empty');
    }

    try {
      return this.stmts.getByGroup.all(groupId) as Memory[];
    } catch (error) {
      wrapSqliteError(error, 'get memories by group');
    }
  }

  delete(groupId: string, topic: string): boolean {
    this.conn.ensureOpen();

    try {
      const result = this.stmts.delete.run(groupId, topic);
      return result.changes > 0;
    } catch (error) {
      wrapSqliteError(error, 'delete memory');
    }
  }
}
