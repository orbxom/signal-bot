import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { type FSWatcher, watch } from 'chokidar';
import type { EventFile, Run, StatusFile, UpdateMessage } from './types.js';

export class RunWatcher extends EventEmitter {
  private runs: Map<string, Run> = new Map();
  private runsDir: string;
  private fsWatcher?: FSWatcher;

  constructor(runsDir: string) {
    super();
    this.runsDir = runsDir;
  }

  start(): void {
    this.fsWatcher = watch(this.runsDir, {
      ignoreInitial: false,
      depth: 1,
      awaitWriteFinish: { stabilityThreshold: 300 },
    });

    this.fsWatcher.on('add', (filePath) => this.handleFile(filePath));
    this.fsWatcher.on('change', (filePath) => this.handleFile(filePath));
    this.fsWatcher.on('ready', () => this.emit('ready'));
  }

  async stop(): Promise<void> {
    await this.fsWatcher?.close();
  }

  getSnapshot(): Record<string, Run> {
    return Object.fromEntries(this.runs);
  }

  private handleFile(filePath: string): void {
    const rel = path.relative(this.runsDir, filePath);
    const parts = rel.split(path.sep);
    if (parts.length !== 2) return;

    const [runId, filename] = parts;
    const run = this.getOrCreateRun(runId);

    let fileType: 'status' | 'diary' | 'event';
    let data: StatusFile | EventFile | string;

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      if (filename === 'status.json') {
        fileType = 'status';
        data = JSON.parse(content) as StatusFile;
        run.status = data;
      } else if (filename === 'diary.md') {
        fileType = 'diary';
        data = content;
        run.diary = data;
      } else if (filename === 'event.json') {
        fileType = 'event';
        data = JSON.parse(content) as EventFile;
        run.event = data;
      } else {
        return;
      }
    } catch {
      return; // file may be mid-write
    }

    const update: UpdateMessage = { type: 'update', runId, file: fileType, data };
    this.emit('update', update);
  }

  private getOrCreateRun(runId: string): Run {
    let run = this.runs.get(runId);
    if (!run) {
      run = {
        runId,
        event: { title: runId },
        status: { runId, currentStage: 'unknown', stages: {} },
        diary: '',
      };
      this.runs.set(runId, run);
    }
    return run;
  }
}
