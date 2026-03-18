import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { type FSWatcher, watch } from 'chokidar';

export type StageStatus = 'pending' | 'in-progress' | 'complete' | 'deferred' | 'abandoned';

export interface StageMap {
  plan: StageStatus;
  build: StageStatus;
  test: StageStatus;
  simplify: StageStatus;
  pr: StageStatus;
  'integration-test': StageStatus;
  review: StageStatus;
}

export const STAGE_ORDER: (keyof StageMap)[] = [
  'plan', 'build', 'test', 'simplify', 'pr', 'integration-test', 'review',
];

export interface StatusFile {
  runId: string;
  currentStage: string;
  stages: Partial<StageMap>;
  updatedAt?: string;
}

export interface EventFile {
  source?: string;
  issueNumber?: number;
  issueUrl?: string;
  title: string;
  description?: string;
  acceptanceCriteria?: string[];
  mode?: string;
  createdAt?: string;
}

export interface Run {
  runId: string;
  event: EventFile;
  status: StatusFile;
  diary: string;
}

export interface UpdateMessage {
  type: 'update';
  runId: string;
  file: 'status' | 'diary' | 'event';
  data: StatusFile | EventFile | string;
}

export class FactoryService extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private runs = new Map<string, Run>();

  constructor(private runsDir: string) {
    super();
  }

  start(): void {
    if (!fs.existsSync(this.runsDir)) {
      console.log('Factory runs dir not found, factory tab will be empty');
      return;
    }

    this.watcher = watch(this.runsDir, {
      ignoreInitial: false,
      depth: 1,
      awaitWriteFinish: { stabilityThreshold: 300 },
    });

    this.watcher.on('add', (fp) => this.handleFile(fp));
    this.watcher.on('change', (fp) => this.handleFile(fp));
    this.watcher.on('ready', () => this.emit('ready'));
  }

  async stop(): Promise<void> {
    await this.watcher?.close();
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
