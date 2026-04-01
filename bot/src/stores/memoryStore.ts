import type { DatabaseConnection } from '../db';
import { wrapSqliteError } from '../db';
import type { MemoryWithTags } from '../types';

export class MemoryStore {
  private conn: DatabaseConnection;

  constructor(conn: DatabaseConnection) {
    this.conn = conn;
    conn.db.pragma('foreign_keys = ON');
  }

  private normalizeTags(tags?: string[]): string[] {
    if (!tags || tags.length === 0) return [];
    const normalized = tags.map(t => t.toLowerCase().trim()).filter(t => t.length > 0);
    return [...new Set(normalized)].sort();
  }

  private getTagsForMemory(id: number): string[] {
    const rows = this.conn.db
      .prepare('SELECT tag FROM memory_tags WHERE memoryId = ? ORDER BY tag ASC')
      .all(id) as Array<{ tag: string }>;
    return rows.map(r => r.tag);
  }

  save(
    groupId: string,
    title: string,
    type: string,
    opts?: { description?: string; content?: string; tags?: string[] },
  ): MemoryWithTags {
    if (!groupId || groupId.trim() === '') {
      throw new Error('Invalid groupId: cannot be empty');
    }
    if (!title || title.trim() === '') {
      throw new Error('Invalid title: cannot be empty');
    }
    if (!type || type.trim() === '') {
      throw new Error('Invalid type: cannot be empty');
    }

    const normalizedType = type.toLowerCase().trim();
    const tags = this.normalizeTags(opts?.tags);

    return this.conn.runOp('save memory', () => {
      const now = Date.now();

      // Check if record exists (for upsert logic — we need to preserve createdAt)
      const existing = this.conn.db
        .prepare('SELECT id, createdAt FROM memories WHERE groupId = ? AND title = ?')
        .get(groupId, title) as { id: number; createdAt: number } | undefined;

      let memoryId: number;

      if (existing) {
        // Fetch current values to avoid overwriting with empty string when opts fields are omitted
        const currentRow = this.conn.db
          .prepare('SELECT description, content FROM memories WHERE id = ?')
          .get(existing.id) as { description: string | null; content: string };
        this.conn.db
          .prepare(
            `UPDATE memories SET
              description = ?,
              content = ?,
              type = ?,
              updatedAt = ?
            WHERE id = ?`,
          )
          .run(
            opts?.description !== undefined ? (opts.description ?? null) : currentRow.description,
            opts?.content !== undefined ? opts.content : currentRow.content,
            normalizedType,
            now,
            existing.id,
          );
        memoryId = existing.id;
      } else {
        const result = this.conn.db
          .prepare(
            `INSERT INTO memories (groupId, title, description, content, type, createdAt, updatedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(groupId, title, opts?.description ?? null, opts?.content ?? null, normalizedType, now, now);
        memoryId = result.lastInsertRowid as number;
      }

      // Replace tags entirely
      this.conn.db.prepare('DELETE FROM memory_tags WHERE memoryId = ?').run(memoryId);
      if (tags.length > 0) {
        const insertTag = this.conn.db.prepare(
          'INSERT OR IGNORE INTO memory_tags (memoryId, tag) VALUES (?, ?)',
        );
        for (const tag of tags) {
          insertTag.run(memoryId, tag);
        }
      }

      const row = this.conn.db
        .prepare('SELECT * FROM memories WHERE id = ?')
        .get(memoryId) as Omit<MemoryWithTags, 'tags'>;

      return { ...row, tags: this.getTagsForMemory(memoryId) };
    });
  }

  update(
    id: number,
    opts: { title?: string; description?: string; content?: string; type?: string; tags?: string[] },
  ): MemoryWithTags | null {
    return this.conn.runOp('update memory', () => {
      const existing = this.conn.db
        .prepare('SELECT * FROM memories WHERE id = ?')
        .get(id) as Omit<MemoryWithTags, 'tags'> | undefined;

      if (!existing) return null;

      const now = Date.now();
      const newTitle = opts.title !== undefined ? opts.title : existing.title;
      const newDescription = opts.description !== undefined ? opts.description : existing.description;
      const newContent = opts.content !== undefined ? opts.content : existing.content;
      const newType = opts.type !== undefined ? opts.type.toLowerCase().trim() : existing.type;

      this.conn.db
        .prepare(
          `UPDATE memories SET
            title = ?,
            description = ?,
            content = ?,
            type = ?,
            updatedAt = ?
          WHERE id = ?`,
        )
        .run(newTitle, newDescription, newContent, newType, now, id);

      if (opts.tags !== undefined) {
        const tags = this.normalizeTags(opts.tags);
        this.conn.db.prepare('DELETE FROM memory_tags WHERE memoryId = ?').run(id);
        if (tags.length > 0) {
          const insertTag = this.conn.db.prepare(
            'INSERT OR IGNORE INTO memory_tags (memoryId, tag) VALUES (?, ?)',
          );
          for (const tag of tags) {
            insertTag.run(id, tag);
          }
        }
      }

      const row = this.conn.db
        .prepare('SELECT * FROM memories WHERE id = ?')
        .get(id) as Omit<MemoryWithTags, 'tags'>;

      return { ...row, tags: this.getTagsForMemory(id) };
    });
  }

  getById(id: number): MemoryWithTags | null {
    return this.conn.runOp('get memory by id', () => {
      const row = this.conn.db
        .prepare('SELECT * FROM memories WHERE id = ?')
        .get(id) as Omit<MemoryWithTags, 'tags'> | undefined;

      if (!row) return null;
      return { ...row, tags: this.getTagsForMemory(id) };
    });
  }

  search(
    groupId: string,
    filters: { keyword?: string; type?: string; tag?: string },
    limit = 20,
  ): MemoryWithTags[] {
    return this.conn.runOp('search memories', () => {
      const clampedLimit = Math.min(limit, 100);
      const conditions: string[] = ['m.groupId = ?'];
      const params: unknown[] = [groupId];

      if (filters.keyword) {
        conditions.push('(m.title LIKE ? OR m.description LIKE ? OR m.content LIKE ?)');
        const pattern = `%${filters.keyword}%`;
        params.push(pattern, pattern, pattern);
      }

      if (filters.type) {
        conditions.push('m.type = ?');
        params.push(filters.type);
      }

      if (filters.tag) {
        conditions.push('EXISTS (SELECT 1 FROM memory_tags mt WHERE mt.memoryId = m.id AND mt.tag = ?)');
        params.push(filters.tag);
      }

      params.push(clampedLimit);

      const sql = `
        SELECT m.*
        FROM memories m
        WHERE ${conditions.join(' AND ')}
        ORDER BY m.updatedAt DESC
        LIMIT ?
      `;

      const rows = this.conn.db.prepare(sql).all(...params) as Array<Omit<MemoryWithTags, 'tags'>>;
      return rows.map(row => ({ ...row, tags: this.getTagsForMemory(row.id) }));
    });
  }

  listTypes(groupId: string): string[] {
    return this.conn.runOp('list memory types', () => {
      const rows = this.conn.db
        .prepare('SELECT DISTINCT type FROM memories WHERE groupId = ? ORDER BY type ASC')
        .all(groupId) as Array<{ type: string }>;
      return rows.map(r => r.type);
    });
  }

  listTags(groupId: string): string[] {
    return this.conn.runOp('list memory tags', () => {
      const rows = this.conn.db
        .prepare(
          `SELECT DISTINCT mt.tag
          FROM memory_tags mt
          JOIN memories m ON m.id = mt.memoryId
          WHERE m.groupId = ?
          ORDER BY mt.tag ASC`,
        )
        .all(groupId) as Array<{ tag: string }>;
      return rows.map(r => r.tag);
    });
  }

  manageTags(id: number, add: string[], remove: string[]): MemoryWithTags | null {
    return this.conn.runOp('manage memory tags', () => {
      const existing = this.conn.db
        .prepare('SELECT id FROM memories WHERE id = ?')
        .get(id) as { id: number } | undefined;

      if (!existing) return null;

      const now = Date.now();

      // Remove tags
      if (remove.length > 0) {
        const normalized = this.normalizeTags(remove);
        const delStmt = this.conn.db.prepare('DELETE FROM memory_tags WHERE memoryId = ? AND tag = ?');
        for (const tag of normalized) {
          delStmt.run(id, tag);
        }
      }

      // Add tags (idempotent via INSERT OR IGNORE)
      if (add.length > 0) {
        const normalized = this.normalizeTags(add);
        const insertTag = this.conn.db.prepare(
          'INSERT OR IGNORE INTO memory_tags (memoryId, tag) VALUES (?, ?)',
        );
        for (const tag of normalized) {
          insertTag.run(id, tag);
        }
      }

      // Update updatedAt
      this.conn.db.prepare('UPDATE memories SET updatedAt = ? WHERE id = ?').run(now, id);

      const row = this.conn.db
        .prepare('SELECT * FROM memories WHERE id = ?')
        .get(id) as Omit<MemoryWithTags, 'tags'>;

      return { ...row, tags: this.getTagsForMemory(id) };
    });
  }

  deleteById(id: number): boolean {
    return this.conn.runOp('delete memory by id', () => {
      const result = this.conn.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
      return result.changes > 0;
    });
  }

  getByGroup(groupId: string): MemoryWithTags[] {
    return this.search(groupId, {}, 100);
  }
}
