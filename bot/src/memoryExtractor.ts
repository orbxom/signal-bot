import path from 'node:path';
import { parseEntries, spawnCollect } from './claudeClient';
import { logger } from './logger';
import { SpawnLimiter } from './spawnLimiter';

// --- Constants ---

const DEBOUNCE_MS = 5000;
const READ_TIMEOUT_MS = 10_000;
const WRITE_TIMEOUT_MS = 60_000;
const CLI_PATH = path.resolve(__dirname, 'memory/cli.ts');

// --- Class ---

export class MemoryExtractor {
  private dbPath: string;
  private limiter = new SpawnLimiter(1);
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  /**
   * Pre-response: search group memories for anything relevant to the message.
   * Returns a concise summary string, or null if nothing relevant / timeout / error.
   */
  async readMemories(groupId: string, message: string): Promise<string | null> {
    const prompt = `You are a memory retrieval assistant. Given a message from a group chat, search the group's memories for anything relevant.

Use the Bash tool to run memory CLI commands:
DB_PATH=${this.dbPath} npx tsx ${CLI_PATH} search --group ${groupId} --keyword <word>
DB_PATH=${this.dbPath} npx tsx ${CLI_PATH} search --group ${groupId} --tag <tag>
DB_PATH=${this.dbPath} npx tsx ${CLI_PATH} search --group ${groupId}

Extract 2-3 keywords from the message and search. Also try searching by likely tags.

Output a concise summary of relevant memories, or "No relevant memories found." if nothing matches.

Message: ${message}`;

    const args = [
      '-p',
      prompt,
      '--output-format',
      'json',
      '--max-turns',
      '5',
      '--no-session-persistence',
      '--model',
      'claude-haiku-4-5-20251001',
      '--allowedTools',
      'Bash',
    ];

    try {
      const stdout = await spawnCollect('claude', args, {
        timeout: READ_TIMEOUT_MS,
        env: { ...process.env, DB_PATH: this.dbPath, CLAUDECODE: '' },
        trackChild: child => this.limiter.trackChild(child),
      });

      const entries = parseEntries(stdout);
      const resultEntry = entries.find(e => e.type === 'result');
      if (!resultEntry) return null;

      const text = typeof resultEntry.result === 'string' ? resultEntry.result.trim() : '';
      if (!text || text === 'No relevant memories found.') return null;

      return text;
    } catch (err) {
      logger.warn(`memory-extractor: readMemories failed for group ${groupId}: ${err}`);
      return null;
    }
  }

  /**
   * Schedule a debounced writeMemories call for a group.
   * Multiple calls within DEBOUNCE_MS are coalesced into one write.
   */
  scheduleExtraction(groupId: string, message: string, botResponse: string): void {
    const existing = this.timers.get(groupId);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.timers.delete(groupId);
      this.writeMemories(groupId, message, botResponse).catch(err => {
        logger.error(`memory-extractor: unhandled error for group ${groupId}: ${err}`);
      });
    }, DEBOUNCE_MS);

    this.timers.set(groupId, timer);
  }

  /**
   * Post-response: analyze the conversation and save anything worth remembering.
   * Uses haiku with Bash tool to run CLI commands for listing types/tags, searching, and saving.
   */
  async writeMemories(groupId: string, message: string, botResponse: string): Promise<void> {
    await this.limiter.acquire();
    try {
      await this.doWriteMemories(groupId, message, botResponse);
    } catch (err) {
      logger.error(`memory-extractor: writeMemories failed for group ${groupId}: ${err}`);
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

  /**
   * Kill all in-flight extraction spawns. Call on shutdown.
   */
  killAll(): void {
    this.limiter.killAll();
  }

  // --- Private helpers ---

  private async doWriteMemories(groupId: string, message: string, botResponse: string): Promise<void> {
    const prompt = `You are a memory extraction assistant. Analyze the conversation and decide what's worth remembering.

Use the Bash tool to run memory CLI commands:
DB_PATH=${this.dbPath} npx tsx ${CLI_PATH} save --group ${groupId} --title "<title>" --type <type> [--description "<desc>"] [--content "<content>"] [--tags <t1,t2>]
DB_PATH=${this.dbPath} npx tsx ${CLI_PATH} search --group ${groupId} [--keyword <kw>]
DB_PATH=${this.dbPath} npx tsx ${CLI_PATH} list-types --group ${groupId}
DB_PATH=${this.dbPath} npx tsx ${CLI_PATH} list-tags --group ${groupId}

IMPORTANT: First run list-types and list-tags to see existing categories, then search to avoid duplicates.

Save anything worth remembering: facts, preferences, URLs, plans, notable events.
Be aggressive but don't duplicate existing memories.

Conversation:
User: ${message}
Bot: ${botResponse}`;

    const args = [
      '-p',
      prompt,
      '--output-format',
      'json',
      '--max-turns',
      '10',
      '--no-session-persistence',
      '--model',
      'claude-haiku-4-5-20251001',
      '--allowedTools',
      'Bash',
    ];

    logger.step(`memory-extractor: spawning writeMemories for group ${groupId}`);

    const stdout = await spawnCollect('claude', args, {
      timeout: WRITE_TIMEOUT_MS,
      env: { ...process.env, DB_PATH: this.dbPath, CLAUDECODE: '' },
      trackChild: child => this.limiter.trackChild(child),
    });

    const entries = parseEntries(stdout);
    const resultEntry = entries.find(e => e.type === 'result');
    const resultText = typeof resultEntry?.result === 'string' ? resultEntry.result.trim() : '';

    if (resultText) {
      logger.step(`memory-extractor: saved memories for group ${groupId}: ${resultText.substring(0, 200)}`);
    }
  }
}
