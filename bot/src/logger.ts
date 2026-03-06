import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export interface LoggerOptions {
  logDir: string;
}

// ANSI color codes
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';

// Box-drawing characters
const BOX_TOP = '\u250c'; // ┌
const BOX_SIDE = '\u2502'; // │
const BOX_BOTTOM = '\u2514'; // └
const DASH = '\u2500'; // ─

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequence stripping requires matching ESC character
const ANSI_STRIP_RE = /\x1b\[[0-9;]*m/g;

export class Logger {
  private readonly logFile: string;

  constructor(options: LoggerOptions) {
    mkdirSync(options.logDir, { recursive: true });
    const timestamp = new Date()
      .toISOString()
      .replace(/:/g, '-')
      .replace(/\.\d+Z$/, '');
    this.logFile = path.join(options.logDir, `bot-${timestamp}.log`);
  }

  info(message: string): void {
    this.write(`${this.formatTimestamp()} ${message}\n`);
  }

  success(message: string): void {
    this.write(`${this.formatTimestamp()} ${GREEN}${message}${RESET}\n`);
  }

  warn(message: string): void {
    this.write(`${this.formatTimestamp()} ${YELLOW}${message}${RESET}\n`);
  }

  error(message: string, err?: unknown): void {
    let line = `${this.formatTimestamp()} ${RED}${message}${RESET}`;
    if (err !== undefined) {
      const detail = err instanceof Error ? err.message : String(err);
      line += ` ${RED}(${detail})${RESET}`;
    }
    this.write(`${line}\n`);
  }

  debug(message: string): void {
    this.write(`${this.formatTimestamp()} ${DIM}${message}${RESET}\n`);
  }

  group(label: string): void {
    this.write(`${this.formatTimestamp()} ${CYAN}${BOX_TOP}${RESET} ${label}\n`);
  }

  step(message: string): void {
    this.write(`${this.formatTimestamp()} ${CYAN}${BOX_SIDE}${RESET} ${message}\n`);
  }

  groupEnd(): void {
    this.write(`${this.formatTimestamp()} ${CYAN}${BOX_BOTTOM}${RESET} COMPLETE\n`);
  }

  compact(tag: string, detail: string): void {
    this.write(`${this.formatTimestamp()} ${DASH} ${tag}  ${detail}\n`);
  }

  private formatTimestamp(): string {
    const now = new Date();
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    const s = String(now.getSeconds()).padStart(2, '0');
    return `${DIM}${h}:${m}:${s}${RESET}`;
  }

  private write(line: string): void {
    process.stdout.write(line);
    const stripped = line.replace(ANSI_STRIP_RE, '');
    appendFileSync(this.logFile, stripped);
  }
}

// Singleton instance — log directory is at repo root
const LOG_DIR = path.resolve(__dirname, '..', '..', 'logs');
export const logger = new Logger({ logDir: LOG_DIR });
