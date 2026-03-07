# Dark Factory Dashboard

Real-time monitoring dashboard for Dark Factory pipeline runs. Watches `factory/runs/` for file changes and pushes updates to connected browsers via WebSocket.

## Quick Start

```bash
cd dashboard
npm install
npm run dev       # tsx watch mode — auto-reloads on source changes
```

Open http://localhost:3333

## Architecture

```
dashboard/
  src/
    server.ts     — HTTP static file server + WebSocket server
    watcher.ts    — Chokidar-based file watcher, emits updates on change
    types.ts      — Shared types (Run, StatusFile, EventFile, WsMessage)
  public/
    index.html    — Single-page Preact app (loaded via esm.sh CDN)
```

### Server (`src/server.ts`)
- Serves static files from `public/`
- Exposes `GET /api/runs` for a JSON snapshot of all runs
- Upgrades connections to WebSocket — sends a full snapshot on connect, then incremental updates

### Watcher (`src/watcher.ts`)
- Uses [chokidar](https://github.com/paulmillr/chokidar) to watch `factory/runs/*/`
- Monitors three files per run: `status.json`, `event.json`, `diary.md`
- Emits `update` events with the changed file's data, which the server broadcasts to all WebSocket clients

### Frontend (`public/index.html`)
- Single HTML file with inline CSS and a Preact app (via [htm](https://github.com/developit/htm) tagged templates)
- Connects via WebSocket for real-time updates with auto-reconnect and exponential backoff
- Displays run cards with:
  - Pipeline progress bar (7 stages: plan, build, test, simplify, PR, integration-test, review)
  - Current stage badge with color-coded status
  - Expandable diary panel
  - Relative timestamps (created/updated)
- Completed runs are dimmed; active runs have an animated top border
- Sorted by most recently updated first

## Configuration

| Env Var | Default | Description |
|---------|---------|-------------|
| `DASHBOARD_PORT` | `3333` | HTTP + WebSocket port |
| `FACTORY_RUNS_DIR` | `../factory/runs` | Path to factory runs directory |

## Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start with tsx watch (auto-reload on changes) |
| `npm start` | Start without watch mode |
