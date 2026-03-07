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
watcher.start();

// --- Start ---
server.listen(PORT, () => {
  console.log(`Dashboard: http://localhost:${PORT}`);
});
