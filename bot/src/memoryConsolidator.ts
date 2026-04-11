import { parseEntries, spawnCollect, stripCodeFences } from './claudeClient';
import { logger } from './logger';
import { estimateTokens } from './mcp/result';
import { SpawnLimiter } from './spawnLimiter';
import type { Storage } from './storage';

const MESSAGE_TOKEN_BUDGET = 4000;
const DAILY_RETENTION_DAYS = 14;

export interface ConsolidationResult {
  dossierUpdates: Array<{
    personId: string;
    displayName: string;
    notes: string;
  }>;
  memoryUpdates: Array<{
    action: 'upsert' | 'delete';
    title: string;
    content?: string;
  }>;
  dailySummary: string;
}

const CONSOLIDATION_PROMPT = `You are a memory consolidation agent for a family Signal group chat bot.

Your job is to review the last 24 hours of messages and produce structured updates.

You will be given:
1. Recent messages from the group
2. Existing dossiers (what we know about each person)
3. Existing memories (group-level facts and knowledge)

Produce a JSON response with exactly this structure:
{
  "dossierUpdates": [
    { "personId": "<sender name>", "displayName": "<display name>", "notes": "<updated notes about this person>" }
  ],
  "memoryUpdates": [
    { "action": "upsert", "title": "<title-slug>", "content": "<memory content>" },
    { "action": "delete", "title": "<title-slug>" }
  ],
  "dailySummary": "<1-3 sentence summary of what happened today>"
}

Guidelines:
- Only include dossierUpdates for people who revealed new information about themselves
- Merge new info with existing dossier notes — don't replace, augment
- Memory titles should be kebab-case slugs (e.g., "movie-night-schedule", "vacation-plans")
- Delete memories that are no longer relevant or were contradicted
- The daily summary should capture the key events/topics, not every message
- Keep each memory content under 500 tokens
- Keep each dossier notes under 1000 tokens
- If nothing notable happened, return empty arrays and a brief summary
- Return ONLY valid JSON, no markdown fences or extra text`;

export class MemoryConsolidator {
  private storage: Storage;
  private timezone: string;
  private limiter = new SpawnLimiter(1);

  constructor(storage: Storage, timezone: string) {
    this.storage = storage;
    this.timezone = timezone;
  }

  killAll(): void {
    this.limiter.killAll();
  }

  /**
   * Run consolidation if it hasn't been run today.
   * Checks schema_meta for 'consolidation_last_run' timestamp.
   */
  async runIfDue(): Promise<void> {
    const lastRun = this.getLastRunTimestamp();
    if (lastRun) {
      const lastRunDate = new Date(lastRun);
      const now = new Date();
      // Same calendar day check (in configured timezone)
      const lastRunDay = lastRunDate.toLocaleDateString('en-AU', { timeZone: this.timezone });
      const today = now.toLocaleDateString('en-AU', { timeZone: this.timezone });
      if (lastRunDay === today) {
        logger.debug('consolidator: already ran today, skipping');
        return;
      }
    }

    logger.step('consolidator: starting daily consolidation');

    const groupIds = this.storage.getDistinctGroupIds();
    for (const groupId of groupIds) {
      try {
        await this.consolidateGroup(groupId);
        this.trimOldDailies(groupId, DAILY_RETENTION_DAYS);
      } catch (error) {
        logger.error(`consolidator: failed for group ${groupId}: ${error}`);
      }
    }

    this.setLastRunTimestamp(Date.now());
    logger.step('consolidator: daily consolidation complete');
  }

  /**
   * Consolidate a single group: read last 24h of messages, existing knowledge,
   * spawn Claude to produce updates, apply them atomically.
   */
  async consolidateGroup(groupId: string): Promise<void> {
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const messages = this.storage.messages.getByDateRange(groupId, oneDayAgo, Date.now());

    if (messages.length === 0) {
      logger.debug(`consolidator: no messages in last 24h for group ${groupId}, skipping`);
      return;
    }

    // Build context with token budget
    let tokenCount = 0;
    const messageLines: string[] = [];
    for (const msg of messages) {
      const line = `[${new Date(msg.timestamp).toISOString()}] ${msg.sender}: ${msg.content}`;
      const lineTokens = estimateTokens(line);
      if (tokenCount + lineTokens > MESSAGE_TOKEN_BUDGET) break;
      messageLines.push(line);
      tokenCount += lineTokens;
    }

    const dossiers = this.storage.getDossiersByGroup(groupId);
    const memories = this.storage.getMemoriesByGroup(groupId);

    const contextParts = ['## Recent Messages (last 24h)', messageLines.join('\n')];

    if (dossiers.length > 0) {
      contextParts.push(
        '\n## Existing Dossiers',
        ...dossiers.map(d => `- ${d.displayName} (${d.personId}): ${d.notes}`),
      );
    }

    if (memories.length > 0) {
      contextParts.push('\n## Existing Memories', ...memories.map(m => `- ${m.title}: ${m.content}`));
    }

    const prompt = contextParts.join('\n');

    await this.limiter.acquire();
    try {
      const args = [
        '-p',
        prompt,
        '--output-format',
        'json',
        '--max-turns',
        '1',
        '--no-session-persistence',
        '--system-prompt',
        CONSOLIDATION_PROMPT,
        '--model',
        'claude-sonnet-4-6',
        '--allowedTools',
        '',
      ];

      const stdout = await spawnCollect('claude', args, {
        timeout: 60_000,
        env: { ...process.env, CLAUDECODE: '' },
        trackChild: child => this.limiter.trackChild(child),
      });

      const result = this.parseConsolidationOutput(stdout);
      this.applyResult(groupId, result);

      logger.step(
        `consolidator: group ${groupId} — ` +
          `${result.dossierUpdates.length} dossier updates, ` +
          `${result.memoryUpdates.length} memory updates`,
      );
    } catch (error) {
      logger.error(`consolidator: spawn failed for group ${groupId}: ${error}`);
    } finally {
      this.limiter.release();
    }
  }

  /**
   * Remove daily summaries older than retentionDays.
   */
  trimOldDailies(groupId: string, retentionDays: number): void {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);
    const cutoffTitle = `__daily:${cutoff.toISOString().slice(0, 10)}`;
    this.storage.memories.deleteOldDailies(groupId, cutoffTitle);
  }

  private parseConsolidationOutput(stdout: string): ConsolidationResult {
    const entries = parseEntries(stdout);
    const resultEntry = entries.find(e => e.type === 'result');

    if (!resultEntry) {
      throw new Error('No result entry in Claude output');
    }

    const resultText = typeof resultEntry.result === 'string' ? resultEntry.result : '';
    const parsed = JSON.parse(stripCodeFences(resultText));
    return {
      dossierUpdates: parsed.dossierUpdates || [],
      memoryUpdates: parsed.memoryUpdates || [],
      dailySummary: parsed.dailySummary || '',
    };
  }

  private applyResult(groupId: string, result: ConsolidationResult): void {
    this.storage.conn.transaction(() => {
      // Apply dossier updates
      for (const update of result.dossierUpdates) {
        this.storage.upsertDossier(groupId, update.personId, update.displayName, update.notes);
      }

      // Apply memory updates
      for (const update of result.memoryUpdates) {
        if (update.action === 'upsert' && update.content) {
          this.storage.memories.save(groupId, update.title, 'text', { content: update.content });
        } else if (update.action === 'delete') {
          this.storage.memories.deleteByTitle(groupId, update.title);
        }
      }

      // Store daily summary
      if (result.dailySummary) {
        const today = new Date().toLocaleDateString('en-CA', { timeZone: this.timezone }); // YYYY-MM-DD format
        this.storage.memories.save(groupId, `__daily:${today}`, 'text', { content: result.dailySummary });
      }
    });
  }

  private getLastRunTimestamp(): number | null {
    const row = this.storage.conn.db
      .prepare("SELECT value FROM schema_meta WHERE key = 'consolidation_last_run'")
      .get() as { value: string } | undefined;
    return row ? Number(row.value) : null;
  }

  private setLastRunTimestamp(timestamp: number): void {
    this.storage.conn.db
      .prepare(
        "INSERT INTO schema_meta (key, value) VALUES ('consolidation_last_run', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(String(timestamp));
  }
}
