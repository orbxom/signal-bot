import { spawn } from 'node:child_process';
import { logger } from './logger';
import { SpawnLimiter } from './spawnLimiter';
import type { Storage } from './storage';

// --- Types ---

interface DossierUpdate {
  action: 'add' | 'update';
  personId: string;
  displayName: string;
  notes: string;
}

interface MemoryUpdate {
  action: 'add' | 'update' | 'delete';
  topic: string;
  content?: string;
}

interface ExtractionResult {
  dossierUpdates: DossierUpdate[];
  memoryUpdates: MemoryUpdate[];
}

// --- Prompt ---

const EXTRACTION_PROMPT = `You are a memory extraction assistant. Analyze the recent conversation and existing dossiers/memories, then output a JSON object with updates.

Rules:
- Only output dossier updates when you learn NEW information about a person (name, preferences, facts).
- Only output memory updates when the group establishes a new fact, plan, or preference worth remembering.
- Use action "update" for dossiers (creates or updates). Use action "add"/"update" for new/changed memories, "delete" for obsolete ones.
- personId for dossiers should be the sender's phone number or identifier.
- Keep notes concise (under 500 tokens). Keep memory content concise (under 300 tokens).
- If there is nothing worth extracting, return empty arrays.

Output ONLY valid JSON matching this schema (no markdown, no explanation):
{
  "dossierUpdates": [
    { "action": "update", "personId": "string", "displayName": "string", "notes": "string" }
  ],
  "memoryUpdates": [
    { "action": "add|update|delete", "topic": "string", "content": "string (optional for delete)" }
  ]
}`;

// --- Debounce interval ---

const DEBOUNCE_MS = 5000;
const SPAWN_TIMEOUT_MS = 30_000;

// --- Class ---

export class MemoryExtractor {
  private storage: Storage;
  private limiter = new SpawnLimiter(1);
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(storage: Storage) {
    this.storage = storage;
  }

  /**
   * Schedule a debounced extraction for a group.
   * Multiple calls within DEBOUNCE_MS are coalesced into one extraction.
   */
  scheduleExtraction(groupId: string): void {
    const existing = this.timers.get(groupId);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.timers.delete(groupId);
      this.extract(groupId).catch(err => {
        logger.error(`memory-extractor: unhandled error for group ${groupId}: ${err}`);
      });
    }, DEBOUNCE_MS);

    this.timers.set(groupId, timer);
  }

  /**
   * Run extraction for a group: read recent context, spawn Claude, parse and apply updates.
   * Concurrency-limited to 1. Failures are logged silently.
   */
  async extract(groupId: string): Promise<void> {
    await this.limiter.acquire();
    try {
      await this.doExtract(groupId);
    } catch (err) {
      logger.error(`memory-extractor: extraction failed for group ${groupId}: ${err}`);
    } finally {
      this.limiter.release();
    }
  }

  /**
   * Cancel all pending scheduled extractions. Call on shutdown.
   */
  clearTimers(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  // --- Private helpers ---

  private async doExtract(groupId: string): Promise<void> {
    const prompt = this.buildPrompt(groupId);
    const args = ['-p', prompt, '--output-format', 'json', '--max-turns', '1', '--no-session-persistence'];

    logger.step(`memory-extractor: spawning extraction for group ${groupId}`);

    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn('claude', args, {
        env: { ...process.env, CLAUDECODE: '' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stdin.end();
      this.limiter.trackChild(child);

      const chunks: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));

      const timer = setTimeout(() => {
        child.kill();
        setTimeout(() => {
          try {
            if (!child.killed) child.kill('SIGKILL');
          } catch {}
        }, 5000);
        reject(new Error('Extraction timed out'));
      }, SPAWN_TIMEOUT_MS);

      child.on('close', code => {
        clearTimeout(timer);
        if (code !== 0) reject(new Error(`claude exited with code ${code}`));
        else resolve(Buffer.concat(chunks).toString());
      });
      child.on('error', err => {
        clearTimeout(timer);
        reject(err);
      });
    });

    const result = this.parseResult(stdout);
    if (result) {
      this.applyUpdates(groupId, result);
    }
  }

  private buildPrompt(groupId: string): string {
    // Gather recent messages
    const messages = this.storage.getRecentMessages(groupId, 20);
    const messageLines = messages.map(m => {
      const time = new Date(m.timestamp).toISOString();
      const sender = m.isBot ? 'Bot' : m.sender;
      return `[${time}] ${sender}: ${m.content}`;
    });

    // Gather existing dossiers
    const dossiers = this.storage.getDossiersByGroup(groupId);
    const dossierLines = dossiers.map(d => `- ${d.displayName} (${d.personId}): ${d.notes}`);

    // Gather existing memories
    const memories = this.storage.getMemoriesByGroup(groupId);
    const memoryLines = memories.map(m => `- ${m.topic}: ${m.content}`);

    const parts = [
      EXTRACTION_PROMPT,
      '',
      '## Recent Messages',
      messageLines.length > 0 ? messageLines.join('\n') : '(none)',
      '',
      '## Existing Dossiers',
      dossierLines.length > 0 ? dossierLines.join('\n') : '(none)',
      '',
      '## Existing Memories',
      memoryLines.length > 0 ? memoryLines.join('\n') : '(none)',
    ];

    return parts.join('\n');
  }

  private parseResult(stdout: string): ExtractionResult | null {
    try {
      // Parse the Claude CLI JSON output to find the result line
      const entries = JSON.parse(stdout.trim());
      const resultEntry = Array.isArray(entries) ? entries.find((e: { type: string }) => e.type === 'result') : null;

      if (!resultEntry) {
        logger.warn('memory-extractor: no result entry in Claude output');
        return null;
      }

      const resultText = typeof resultEntry.result === 'string' ? resultEntry.result : '';
      if (!resultText) {
        logger.warn('memory-extractor: empty result text');
        return null;
      }

      const parsed = JSON.parse(resultText);

      // Validate shape
      if (!Array.isArray(parsed.dossierUpdates) || !Array.isArray(parsed.memoryUpdates)) {
        logger.warn('memory-extractor: result missing dossierUpdates or memoryUpdates arrays');
        return null;
      }

      return parsed as ExtractionResult;
    } catch (err) {
      logger.warn(`memory-extractor: failed to parse extraction result: ${err}`);
      return null;
    }
  }

  private applyUpdates(groupId: string, result: ExtractionResult): void {
    let dossierCount = 0;
    let memoryCount = 0;

    for (const du of result.dossierUpdates) {
      try {
        if (!du.personId || !du.displayName) continue;
        this.storage.upsertDossier(groupId, du.personId, du.displayName, du.notes || '');
        dossierCount++;
      } catch (err) {
        logger.warn(`memory-extractor: failed to upsert dossier ${du.personId}: ${err}`);
      }
    }

    for (const mu of result.memoryUpdates) {
      try {
        if (!mu.topic) continue;

        if (mu.action === 'delete') {
          this.storage.deleteMemory(groupId, mu.topic);
          memoryCount++;
        } else if (mu.content) {
          this.storage.upsertMemory(groupId, mu.topic, mu.content);
          memoryCount++;
        }
      } catch (err) {
        logger.warn(`memory-extractor: failed to apply memory update for "${mu.topic}": ${err}`);
      }
    }

    if (dossierCount > 0 || memoryCount > 0) {
      logger.step(
        `memory-extractor: applied ${dossierCount} dossier + ${memoryCount} memory updates for group ${groupId}`,
      );
    }
  }
}
