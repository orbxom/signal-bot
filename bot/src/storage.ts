import Database from 'better-sqlite3';
import { Message, BotConfig } from './types';

export class Storage {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.initTables();
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        groupId TEXT NOT NULL,
        sender TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        isBot INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_group_timestamp
      ON messages(groupId, timestamp DESC);

      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  addMessage(message: Omit<Message, 'id'>): void {
    const stmt = this.db.prepare(`
      INSERT INTO messages (groupId, sender, content, timestamp, isBot)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(
      message.groupId,
      message.sender,
      message.content,
      message.timestamp,
      message.isBot ? 1 : 0
    );
  }

  getRecentMessages(groupId: string, limit: number): Message[] {
    const stmt = this.db.prepare(`
      SELECT * FROM messages
      WHERE groupId = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);
    const rows = stmt.all(groupId, limit) as any[];
    return rows.reverse().map(row => ({
      id: row.id,
      groupId: row.groupId,
      sender: row.sender,
      content: row.content,
      timestamp: row.timestamp,
      isBot: row.isBot === 1
    }));
  }

  trimMessages(groupId: string, keepCount: number): void {
    this.db.prepare(`
      DELETE FROM messages
      WHERE groupId = ?
      AND id NOT IN (
        SELECT id FROM messages
        WHERE groupId = ?
        ORDER BY timestamp DESC
        LIMIT ?
      )
    `).run(groupId, groupId, keepCount);
  }

  close(): void {
    this.db.close();
  }
}
