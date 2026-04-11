import express from 'express';
import { createServer } from 'http';
import path from 'path';
import { Storage } from '../../bot/src/storage';
import { SignalClient } from '../../bot/src/signalClient';
import { WebSocketHub } from './websocket';
import { HealthService } from './services/healthService';
import { DbPoller } from './services/dbPoller';
import { FactoryService } from './services/factoryService';
import { createHealthRoutes } from './routes/health';
import { createGroupRoutes } from './routes/groups';
import { createReminderRoutes } from './routes/reminders';
import { createDossierRoutes } from './routes/dossiers';
import { createPersonaRoutes } from './routes/personas';
import { createMemoryRoutes } from './routes/memories';
import { createMessageRoutes } from './routes/messages';
import { createAttachmentRoutes } from './routes/attachments';
import { createFactoryRoutes } from './routes/factory';

const PORT = Number(process.env.DASHBOARD_PORT || 3333);
const DB_PATH = process.env.DB_PATH || path.resolve(__dirname, '../../bot/data/bot.db');
const SIGNAL_CLI_URL = process.env.SIGNAL_CLI_URL || 'http://localhost:8080';
const BOT_PHONE_NUMBER = process.env.BOT_PHONE_NUMBER || '';
const FACTORY_RUNS_DIR = process.env.FACTORY_RUNS_DIR || path.resolve(__dirname, '../../factory/runs');

// Initialize core dependencies
const storage = new Storage(DB_PATH);
const signalClient = new SignalClient(SIGNAL_CLI_URL, BOT_PHONE_NUMBER);

const app = express();
app.use(express.json());

const httpServer = createServer(app);
const wsHub = new WebSocketHub(httpServer);

// Initialize services
const healthService = new HealthService(storage, signalClient, DB_PATH);
const dbPoller = new DbPoller(storage, wsHub);
const factoryService = new FactoryService(FACTORY_RUNS_DIR);

// Register API routes under /api
app.use('/api', createHealthRoutes(healthService, storage));
app.use('/api', createGroupRoutes(storage, signalClient));
app.use('/api', createReminderRoutes(storage));
app.use('/api', createDossierRoutes(storage));
app.use('/api', createPersonaRoutes(storage));
app.use('/api', createMemoryRoutes(storage));
app.use('/api', createMessageRoutes(storage));
app.use('/api', createAttachmentRoutes(storage));
app.use('/api', createFactoryRoutes(factoryService));

// Export config for external use
export { DB_PATH, SIGNAL_CLI_URL, BOT_PHONE_NUMBER, FACTORY_RUNS_DIR, app, wsHub };

// Serve built React app in production
const clientDist = path.resolve(__dirname, '../client/dist');
app.use(express.static(clientDist));
app.get('*', (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

// Start services and server
dbPoller.start();
factoryService.start();
factoryService.on('update', (msg) => wsHub.broadcast({ type: 'factory:update', data: msg }));

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Dashboard running at http://0.0.0.0:${PORT}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  dbPoller.stop();
  factoryService.stop();
  storage.close();
  httpServer.close();
  process.exit(0);
});
