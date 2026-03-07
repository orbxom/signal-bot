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
