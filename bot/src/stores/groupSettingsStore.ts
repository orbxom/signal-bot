import type { DatabaseConnection } from '../db';

export interface GroupSettings {
  groupId: string;
  enabled: boolean;
  customTriggers: string[] | null;
  contextWindowSize: number | null;
  toolNotifications: boolean;
  createdAt: number;
  updatedAt: number;
}

interface UpsertInput {
  enabled?: boolean;
  customTriggers?: string[] | null;
  contextWindowSize?: number | null;
  toolNotifications?: boolean;
}

export class GroupSettingsStore {
  private readonly get_: ReturnType<DatabaseConnection['db']['prepare']>;
  private readonly upsert_: ReturnType<DatabaseConnection['db']['prepare']>;
  private readonly isEnabled_: ReturnType<DatabaseConnection['db']['prepare']>;
  private readonly getTriggers_: ReturnType<DatabaseConnection['db']['prepare']>;
  private readonly getToolNotifications_: ReturnType<DatabaseConnection['db']['prepare']>;
  private readonly listAll_: ReturnType<DatabaseConnection['db']['prepare']>;

  constructor(conn: DatabaseConnection) {
    this.get_ = conn.db.prepare('SELECT * FROM group_settings WHERE groupId = ?');
    this.upsert_ = conn.db.prepare(`
      INSERT INTO group_settings (groupId, enabled, customTriggers, contextWindowSize, toolNotifications, createdAt, updatedAt)
      VALUES (@groupId, @enabled, @customTriggers, @contextWindowSize, @toolNotifications, @now, @now)
      ON CONFLICT(groupId) DO UPDATE SET
        enabled = @enabled,
        customTriggers = @customTriggers,
        contextWindowSize = @contextWindowSize,
        toolNotifications = @toolNotifications,
        updatedAt = @now
    `);
    this.isEnabled_ = conn.db.prepare('SELECT enabled FROM group_settings WHERE groupId = ?');
    this.getTriggers_ = conn.db.prepare('SELECT customTriggers FROM group_settings WHERE groupId = ?');
    this.getToolNotifications_ = conn.db.prepare('SELECT toolNotifications FROM group_settings WHERE groupId = ?');
    this.listAll_ = conn.db.prepare('SELECT * FROM group_settings ORDER BY updatedAt DESC LIMIT ? OFFSET ?');
  }

  get(groupId: string): GroupSettings | null {
    const row = this.get_.get(groupId) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  upsert(groupId: string, input: UpsertInput): void {
    const existing = this.get(groupId);
    this.upsert_.run({
      groupId,
      enabled: (input.enabled ?? existing?.enabled ?? true) ? 1 : 0,
      customTriggers:
        input.customTriggers !== undefined
          ? input.customTriggers
            ? JSON.stringify(input.customTriggers)
            : null
          : existing?.customTriggers
            ? JSON.stringify(existing.customTriggers)
            : null,
      contextWindowSize: input.contextWindowSize ?? existing?.contextWindowSize ?? null,
      toolNotifications: (input.toolNotifications ?? existing?.toolNotifications ?? true) ? 1 : 0,
      now: Date.now(),
    });
  }

  isEnabled(groupId: string): boolean {
    const row = this.isEnabled_.get(groupId) as { enabled: number } | undefined;
    return row ? row.enabled === 1 : true; // default enabled
  }

  getTriggers(groupId: string): string[] | null {
    const row = this.getTriggers_.get(groupId) as { customTriggers: string | null } | undefined;
    if (!row || !row.customTriggers) return null;
    return JSON.parse(row.customTriggers) as string[];
  }

  getToolNotifications(groupId: string): boolean {
    const row = this.getToolNotifications_.get(groupId) as { toolNotifications: number } | undefined;
    return row ? row.toolNotifications === 1 : true; // default enabled
  }

  listAll(limit = 50, offset = 0): GroupSettings[] {
    const rows = this.listAll_.all(limit, offset) as Record<string, unknown>[];
    return rows.map(r => this.mapRow(r));
  }

  private mapRow(row: Record<string, unknown>): GroupSettings {
    return {
      groupId: row.groupId as string,
      enabled: (row.enabled as number) === 1,
      customTriggers: row.customTriggers ? JSON.parse(row.customTriggers as string) : null,
      contextWindowSize: row.contextWindowSize as number | null,
      toolNotifications: (row.toolNotifications as number) === 1,
      createdAt: row.createdAt as number,
      updatedAt: row.updatedAt as number,
    };
  }
}
