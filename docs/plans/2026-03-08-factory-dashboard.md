# Factory Dashboard Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a real-time web dashboard that monitors Dark Factory pipeline runs via file watching and WebSocket.

**Architecture:** A standalone `dashboard/` package (peer to `bot/`) with a Node.js server that watches `factory/runs/*/` for changes using chokidar, serves a static HTML dashboard, and broadcasts updates via WebSocket. The client is a single self-contained Preact+HTM HTML file with no build step.

**Tech Stack:** Node.js, TypeScript, chokidar 5, ws 8, Preact 10 (ESM from CDN), HTM 3

---

### Task 1: Project Scaffolding

**Files:**
- Create: `dashboard/package.json`
- Create: `dashboard/tsconfig.json`
- Create: `dashboard/src/types.ts`

**Step 1: Create `dashboard/package.json`**

```json
{
  "name": "factory-dashboard",
  "version": "1.0.0",
  "private": true,
  "description": "Real-time Dark Factory pipeline dashboard",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "start": "tsx src/server.ts"
  },
  "dependencies": {
    "chokidar": "^5.0.0",
    "ws": "^8.19.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "@types/ws": "^8.18.0",
    "tsx": "^4.7.0",
    "typescript": "^5.3.0"
  }
}
```

**Step 2: Create `dashboard/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "moduleResolution": "node"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

**Step 3: Create `dashboard/src/types.ts`**

```typescript
export interface StageMap {
  plan: StageStatus;
  build: StageStatus;
  test: StageStatus;
  simplify: StageStatus;
  pr: StageStatus;
  'integration-test': StageStatus;
  review: StageStatus;
}

export type StageStatus = 'pending' | 'in-progress' | 'complete' | 'deferred' | 'abandoned';

export const STAGE_ORDER: (keyof StageMap)[] = [
  'plan', 'build', 'test', 'simplify', 'pr', 'integration-test', 'review',
];

export interface StatusFile {
  runId: string;
  currentStage: string;
  stages: StageMap;
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

export interface SnapshotMessage {
  type: 'snapshot';
  runs: Record<string, Run>;
}

export interface UpdateMessage {
  type: 'update';
  runId: string;
  file: 'status' | 'diary' | 'event';
  data: StatusFile | EventFile | string;
}

export type WsMessage = SnapshotMessage | UpdateMessage;
```

**Step 4: Install dependencies**

Run: `cd dashboard && npm install`

**Step 5: Commit**

```bash
git add dashboard/package.json dashboard/tsconfig.json dashboard/src/types.ts
git commit -m "feat(dashboard): scaffold project with types"
```

---

### Task 2: File Watcher + State Manager

**Files:**
- Create: `dashboard/src/watcher.ts`

This module watches `factory/runs/*/` for changes and maintains an in-memory map of all runs. It exposes the current state and emits change events.

**Step 1: Create `dashboard/src/watcher.ts`**

```typescript
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { watch } from 'chokidar';
import type { EventFile, Run, StatusFile, UpdateMessage } from './types.js';

export class RunWatcher extends EventEmitter {
  private runs: Map<string, Run> = new Map();
  private runsDir: string;

  constructor(runsDir: string) {
    super();
    this.runsDir = runsDir;
  }

  start(): void {
    const watcher = watch(
      [
        path.join(this.runsDir, '*/status.json'),
        path.join(this.runsDir, '*/diary.md'),
        path.join(this.runsDir, '*/event.json'),
      ],
      {
        ignoreInitial: false,
        awaitWriteFinish: { stabilityThreshold: 300 },
      },
    );

    watcher.on('add', (filePath) => this.handleFile(filePath));
    watcher.on('change', (filePath) => this.handleFile(filePath));
    watcher.on('ready', () => this.emit('ready'));
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
        status: { runId, currentStage: 'unknown', stages: {} as any },
        diary: '',
      };
      this.runs.set(runId, run);
    }
    return run;
  }
}
```

**Step 2: Verify it compiles**

Run: `cd dashboard && npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add dashboard/src/watcher.ts
git commit -m "feat(dashboard): add file watcher with state management"
```

---

### Task 3: HTTP + WebSocket Server

**Files:**
- Create: `dashboard/src/server.ts`

The server serves static files from `dashboard/public/`, provides a REST endpoint `GET /api/runs` for the initial snapshot, and runs a WebSocket server that broadcasts updates.

**Step 1: Create `dashboard/src/server.ts`**

```typescript
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { SnapshotMessage, UpdateMessage } from './types.js';
import { RunWatcher } from './watcher.js';

const PORT = parseInt(process.env.DASHBOARD_PORT || '3333', 10);
const FACTORY_RUNS = path.resolve(
  process.env.FACTORY_RUNS_DIR || path.join(__dirname, '../../factory/runs'),
);
const PUBLIC_DIR = path.join(__dirname, '../public');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

// --- HTTP Server ---
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/api/runs') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(watcher.getSnapshot()));
    return;
  }

  // Static file serving
  let filePath = path.join(PUBLIC_DIR, req.url === '/' ? 'index.html' : req.url!);
  filePath = path.normalize(filePath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

// --- WebSocket Server ---
const wss = new WebSocketServer({ server });

wss.on('connection', (ws: WebSocket) => {
  const snapshot: SnapshotMessage = { type: 'snapshot', runs: watcher.getSnapshot() };
  ws.send(JSON.stringify(snapshot));
});

function broadcast(message: UpdateMessage): void {
  const data = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(data);
    }
  }
}

// --- Watcher ---
const watcher = new RunWatcher(FACTORY_RUNS);
watcher.on('update', broadcast);
watcher.on('ready', () => {
  console.log(`Watching ${FACTORY_RUNS}`);
  console.log(`Loaded ${Object.keys(watcher.getSnapshot()).length} runs`);
});

// --- Start ---
server.listen(PORT, () => {
  console.log(`Dashboard: http://localhost:${PORT}`);
});
```

**Step 2: Verify it compiles**

Run: `cd dashboard && npx tsc --noEmit`
Expected: No errors

**Step 3: Smoke test — start the server**

Run: `cd dashboard && timeout 3 npx tsx src/server.ts 2>&1 || true`
Expected: Output includes `Dashboard: http://localhost:3333` and `Watching` and a run count

**Step 4: Commit**

```bash
git add dashboard/src/server.ts
git commit -m "feat(dashboard): add HTTP + WebSocket server"
```

---

### Task 4: Dashboard UI

**Files:**
- Create: `dashboard/public/index.html`

A single self-contained HTML file using Preact + HTM from CDN. No build step. Contains all CSS and JS inline.

**Step 1: Create `dashboard/public/index.html`**

This is the largest file. It contains:
- CSS: dark theme, card grid, pipeline bar with color-coded stage dots, expandable diary
- Preact components: `App`, `RunCard`, `StageBar`, `DiaryPanel`, `ConnectionStatus`
- WebSocket connection with auto-reconnect
- State management via `useState` — merges snapshot and delta events

Key design decisions for the implementer:
- Use `htm` tagged templates instead of JSX (no build step needed)
- WebSocket URL derived from `window.location` (works on any port)
- Cards sorted by most recently updated (use `updatedAt` from status.json, fall back to `createdAt` from event.json)
- Pipeline bar: 7 small circles in a row, each colored by stage status
- Diary: rendered as preformatted text (it's already formatted markdown), in a collapsible panel
- Auto-reconnect: on close, retry after 2s with a cap of 10s

The HTML file should be ~300-400 lines. Structure:
```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Dark Factory</title>
  <style>
    /* Dark theme, card grid, pipeline bar, diary panel */
  </style>
</head>
<body>
  <script type="module">
    import { h, render } from 'https://esm.sh/preact@10';
    import { useState, useEffect, useCallback } from 'https://esm.sh/preact@10/hooks';
    import htm from 'https://esm.sh/htm@3';
    const html = htm.bind(h);

    // Components: App, RunCard, StageBar, DiaryPanel, ConnectionStatus
    // WebSocket hook: useWebSocket(onSnapshot, onUpdate)
    // Render
  </script>
</body>
</html>
```

CSS color scheme:
- Background: `#0d1117` (GitHub dark)
- Cards: `#161b22` with `#30363d` border
- Stage colors: complete=`#3fb950`, in-progress=`#58a6ff` (pulsing), pending=`#484f58`, deferred=`#d29922`, abandoned=`#f85149`
- Text: `#e6edf3`

The implementer should use the `frontend-design` skill for the visual design and make it look polished. The CSS and component structure above are guidelines, not rigid specs — the implementer has creative freedom on the visual design as long as the data model and WebSocket integration match the plan.

**Step 2: Verify end-to-end**

Run the server: `cd dashboard && npx tsx src/server.ts`
Open `http://localhost:3333` in a browser.
Expected: Dashboard loads, shows existing factory runs as cards with pipeline progress.

Test live updates: In another terminal, modify a status.json:
```bash
echo '{"runId":"test","currentStage":"build","stages":{"plan":"complete","build":"in-progress"}}' > factory/runs/issue-42-tool-notifications/status.json
```
Expected: The card for issue-42 updates in real-time without page refresh.

**Step 3: Commit**

```bash
git add dashboard/public/index.html
git commit -m "feat(dashboard): add Preact dashboard UI"
```

---

### Task 5: NPM Script + README

**Files:**
- Modify: `dashboard/package.json` (already created in Task 1, verify scripts are correct)
- Create: `dashboard/README.md`

**Step 1: Create `dashboard/README.md`**

```markdown
# Dark Factory Dashboard

Real-time monitoring dashboard for Dark Factory pipeline runs.

## Quick Start

```bash
cd dashboard
npm install
npm run dev
```

Open http://localhost:3333

## How It Works

- Watches `factory/runs/*/` for changes to `status.json`, `diary.md`, and `event.json`
- Broadcasts updates via WebSocket to connected browsers
- Dashboard updates in real-time — no page refresh needed

## Configuration

| Env Var | Default | Description |
|---------|---------|-------------|
| `DASHBOARD_PORT` | `3333` | HTTP + WebSocket port |
| `FACTORY_RUNS_DIR` | `../factory/runs` | Path to factory runs directory |
```

**Step 2: Commit**

```bash
git add dashboard/README.md
git commit -m "docs(dashboard): add README"
```

---

## Task Dependencies

```
Task 1 (scaffolding)
  |
  v
Task 2 (watcher) -----> Task 3 (server) -----> Task 4 (UI) -----> Task 5 (README)
```

Tasks 1-3 are sequential (each depends on the previous). Task 4 depends on Task 3. Task 5 can run after Task 4.

## Notes for Implementer

- The `dashboard/` directory is a **new top-level directory**, peer to `bot/`. It has its own `package.json` and `node_modules`.
- `__dirname` in `server.ts` resolves to `dashboard/src/` when run via `tsx`. Paths to `../public` and `../../factory/runs` are relative to that.
- The UI file (`index.html`) loads Preact from CDN — it needs network access on first load. After that, the browser caches it.
- chokidar's `awaitWriteFinish` with 300ms stability threshold prevents broadcasting partial writes.
- The `getSnapshot()` method returns a plain object (not a Map) for easy JSON serialization.
- For Task 4, use the `frontend-design` skill to create a polished dark-themed dashboard. The color scheme and component structure in the plan are guidelines — creative freedom is encouraged as long as the WebSocket data model is respected.
