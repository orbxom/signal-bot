import type Database from 'better-sqlite3';
import type { DatabaseConnection } from '../db';

export interface WebAppDeployment {
  id: number;
  groupId: string;
  sender: string;
  siteCount: number;
  deployedAt: number;
}

export class WebAppStore {
  private conn: DatabaseConnection;
  private stmts: {
    insert: Database.Statement;
    list: Database.Statement;
    countSince: Database.Statement;
    countGroupSince: Database.Statement;
  };

  constructor(conn: DatabaseConnection) {
    this.conn = conn;
    this.stmts = {
      insert: conn.db.prepare(
        'INSERT INTO web_app_deployments (groupId, sender, siteCount, deployedAt) VALUES (?, ?, ?, ?)',
      ),
      list: conn.db.prepare('SELECT * FROM web_app_deployments ORDER BY deployedAt DESC, id DESC LIMIT ?'),
      countSince: conn.db.prepare('SELECT COUNT(*) as count FROM web_app_deployments WHERE deployedAt >= ?'),
      countGroupSince: conn.db.prepare(
        'SELECT COUNT(*) as count FROM web_app_deployments WHERE groupId = ? AND deployedAt >= ?',
      ),
    };
  }

  recordDeployment(groupId: string, sender: string, siteCount: number): void {
    this.conn.runOp('record deployment', () => {
      this.stmts.insert.run(groupId, sender, siteCount, Date.now());
    });
  }

  getDeployments(limit = 10): WebAppDeployment[] {
    return this.conn.runOp('get deployments', () => {
      return this.stmts.list.all(limit) as WebAppDeployment[];
    });
  }

  countDeploymentsSince(since: number): number {
    return this.conn.runOp('count deployments since', () => {
      const row = this.stmts.countSince.get(since) as { count: number };
      return row.count;
    });
  }

  countGroupDeploymentsSince(groupId: string, since: number): number {
    return this.conn.runOp('count group deployments since', () => {
      const row = this.stmts.countGroupSince.get(groupId, since) as { count: number };
      return row.count;
    });
  }
}
