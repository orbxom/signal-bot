import express from 'express';
import { createServer } from 'http';
import path from 'path';
import { WebSocketHub } from './websocket';

const PORT = Number(process.env.DASHBOARD_PORT || 3333);
const DB_PATH = process.env.DB_PATH || path.resolve(__dirname, '../../bot/data/bot.db');
const SIGNAL_CLI_URL = process.env.SIGNAL_CLI_URL || 'http://localhost:8080';
const BOT_PHONE_NUMBER = process.env.BOT_PHONE_NUMBER || '';
const FACTORY_RUNS_DIR = process.env.FACTORY_RUNS_DIR || path.resolve(__dirname, '../../factory/runs');

const app = express();
app.use(express.json());

const httpServer = createServer(app);
const wsHub = new WebSocketHub(httpServer);

// Export config for route modules to consume
export { DB_PATH, SIGNAL_CLI_URL, BOT_PHONE_NUMBER, FACTORY_RUNS_DIR, app, wsHub };

// Serve built React app in production
const clientDist = path.resolve(__dirname, '../client/dist');
app.use(express.static(clientDist));
app.get('*', (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

httpServer.listen(PORT, '127.0.0.1', () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  httpServer.close();
  process.exit(0);
});
