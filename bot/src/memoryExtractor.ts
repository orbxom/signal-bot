import path from 'node:path';
import { extractResultText, spawnCollect } from './claudeClient';
import { logger } from './logger';
import { SpawnLimiter } from './spawnLimiter';

// --- Constants ---

const DEBOUNCE_MS = 5000;
const READ_TIMEOUT_MS = 30_000;
const WRITE_TIMEOUT_MS = 60_000;
const CLI_PATH = path.resolve(__dirname, 'memory/cli.ts');

// --- Class ---

interface PendingExtraction {
  message: string;
  botResponse: string;
  savedTitles?: string[];
}

export class MemoryExtractor {
  private dbPath: string;
  private limiter = new SpawnLimiter(1);
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private pendingPairs = new Map<string, PendingExtraction[]>();

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  private buildHaikuArgs(prompt: string, maxTurns: number): string[] {
    return [
      '-p',
      prompt,
      '--output-format',
      'json',
      '--max-turns',
      String(maxTurns),
      '--no-session-persistence',
      '--model',
      'claude-haiku-4-5-20251001',
      '--allowedTools',
      'Bash',
    ];
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

    const text = await this.spawnHaiku(prompt, 5, READ_TIMEOUT_MS, `readMemories for group ${groupId}`);
    if (!text || text === 'No relevant memories found.') return null;
    return text;
  }

  /**
   * Schedule a debounced writeMemories call for a group.
   * Multiple calls within DEBOUNCE_MS are coalesced into one write.
   */
  scheduleExtraction(groupId: string, message: string, botResponse: string, savedTitles?: string[]): void {
    const existing = this.timers.get(groupId);
    if (existing) {
      clearTimeout(existing);
    }

    const pairs = this.pendingPairs.get(groupId) || [];
    pairs.push({ message, botResponse, savedTitles });
    this.pendingPairs.set(groupId, pairs);

    const timer = setTimeout(() => {
      this.timers.delete(groupId);
      const accumulated = this.pendingPairs.get(groupId) || [];
      this.pendingPairs.delete(groupId);

      if (accumulated.length === 0) return;

      const combinedMessage = accumulated.map(p => `User: ${p.message}\nBot: ${p.botResponse}`).join('\n\n');
      const allTitles = accumulated.flatMap(p => p.savedTitles || []);

      this.writeMemories(groupId, combinedMessage, allTitles.length > 0 ? allTitles : undefined).catch(err => {
        logger.error(`memory-extractor: unhandled error for group ${groupId}: ${err}`);
      });
    }, DEBOUNCE_MS);

    this.timers.set(groupId, timer);
  }

  /**
   * Post-response: analyze the conversation and save anything worth remembering.
   * Uses haiku with Bash tool to run CLI commands for listing types/tags, searching, and saving.
   */
  async writeMemories(groupId: string, conversation: string, savedTitles?: string[]): Promise<void> {
    await this.limiter.acquire();
    try {
      await this.doWriteMemories(groupId, conversation, savedTitles);
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
    this.pendingPairs.clear();
  }

  /**
   * Kill all in-flight extraction spawns. Call on shutdown.
   */
  killAll(): void {
    this.limiter.killAll();
  }

  // --- Private helpers ---

  private async spawnHaiku(
    prompt: string,
    maxTurns: number,
    timeoutMs: number,
    label: string,
  ): Promise<string | null> {
    try {
      logger.step(`memory-extractor: spawning ${label}`);
      const stdout = await spawnCollect('claude', this.buildHaikuArgs(prompt, maxTurns), {
        timeout: timeoutMs,
        env: { ...process.env, DB_PATH: this.dbPath, CLAUDECODE: '' },
        trackChild: child => this.limiter.trackChild(child),
      });
      return extractResultText(stdout);
    } catch (err) {
      logger.warn(`memory-extractor: ${label} failed: ${err}`);
      return null;
    }
  }

  private async doWriteMemories(groupId: string, conversation: string, savedTitles?: string[]): Promise<void> {
    let prompt = `You are a memory extraction assistant. Analyze the conversation and decide what's worth remembering.

Use the Bash tool to run memory CLI commands:
DB_PATH=${this.dbPath} npx tsx ${CLI_PATH} save --group ${groupId} --title "<title>" --type <type> [--description "<desc>"] [--content "<content>"] [--tags <t1,t2>]
DB_PATH=${this.dbPath} npx tsx ${CLI_PATH} search --group ${groupId} [--keyword <kw>]
DB_PATH=${this.dbPath} npx tsx ${CLI_PATH} list-types --group ${groupId}
DB_PATH=${this.dbPath} npx tsx ${CLI_PATH} list-tags --group ${groupId}

IMPORTANT: First run list-types and list-tags to see existing categories, then search to avoid duplicates.

Save anything worth remembering: facts, preferences, URLs, plans, notable events.
Be aggressive but don't duplicate existing memories.

Conversation:
${conversation}`;

    if (savedTitles && savedTitles.length > 0) {
      prompt += `\n\nThe bot already saved these memories during its response — do NOT save duplicates:\n${savedTitles.map(t => `- "${t}"`).join('\n')}`;
    }

    const resultText = await this.spawnHaiku(prompt, 10, WRITE_TIMEOUT_MS, `writeMemories for group ${groupId}`);

    if (resultText) {
      logger.step(`memory-extractor: saved memories for group ${groupId}: ${resultText.substring(0, 200)}`);
    }
  }
}
