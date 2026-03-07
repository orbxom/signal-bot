import Database from 'better-sqlite3';
import { catchErrors, getErrorMessage, ok } from '../result';
import { runServer } from '../runServer';
import type { McpServerDefinition } from '../types';

const TOOLS = [
  {
    name: 'health_check',
    title: 'Health Check',
    description:
      'Returns a health status report including bot uptime, database connectivity, signal-cli reachability, MCP registry status, and process memory usage. Note: memory values reflect the MCP server subprocess, not the main bot process.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
];

let db: Database.Database | null = null;
let signalCliUrl = '';
let signalAccount = '';
let botStartTime = 0;

function checkDatabase(): { status: string; error?: string } {
  if (!db) return { status: 'error', error: 'Database not initialized' };
  try {
    db.prepare('SELECT 1 AS ok').get();
    return { status: 'ok' };
  } catch (err) {
    return { status: 'error', error: getErrorMessage(err) };
  }
}

async function checkSignal(): Promise<{ status: string; error?: string }> {
  if (!signalCliUrl) {
    return { status: 'unreachable', error: 'SIGNAL_CLI_URL not configured' };
  }
  try {
    const response = await fetch(`${signalCliUrl}/api/v1/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'listGroups',
        params: { account: signalAccount },
        id: 'health-check',
      }),
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) {
      return { status: 'error', error: `HTTP ${response.status}` };
    }
    const result = (await response.json()) as {
      error?: { message: string };
    };
    if (result.error) {
      return { status: 'error', error: `RPC error: ${result.error.message}` };
    }
    return { status: 'ok' };
  } catch (err) {
    return { status: 'unreachable', error: getErrorMessage(err) };
  }
}

function getMemory() {
  return process.memoryUsage();
}

function getMcpRegistry() {
  // Lazy import to avoid circular dependency (index.ts imports healthCheck.ts)
  const { ALL_SERVERS } = require('./index') as {
    ALL_SERVERS: McpServerDefinition[];
  };
  return {
    registeredServers: ALL_SERVERS.length,
    registeredTools: ALL_SERVERS.reduce((sum, s) => sum + s.tools.length, 0),
  };
}

function getUptime(): number {
  if (botStartTime > 0) {
    return (Date.now() - botStartTime) / 1000;
  }
  return process.uptime();
}

function getOverallStatus(dbResult: { status: string }, signalResult: { status: string }): string {
  if (dbResult.status === 'ok' && signalResult.status === 'ok') return 'healthy';
  if (dbResult.status !== 'ok') return 'unhealthy';
  return 'degraded';
}

export const healthCheckServer: McpServerDefinition = {
  serverName: 'signal-bot-health-check',
  configKey: 'healthCheck',
  entrypoint: 'healthCheck',
  tools: TOOLS,
  envMapping: {
    DB_PATH: 'dbPath',
    SIGNAL_CLI_URL: 'signalCliUrl',
    SIGNAL_ACCOUNT: 'botPhoneNumber',
    BOT_START_TIME: 'botStartTime',
  },
  handlers: {
    health_check() {
      return catchErrors(async () => {
        const database = checkDatabase();
        const signal = await checkSignal();
        const memory = getMemory();
        const uptime = getUptime();
        const mcp = getMcpRegistry();
        const status = getOverallStatus(database, signal);

        return ok(
          JSON.stringify({
            status,
            uptime,
            database,
            signal,
            mcp,
            memory,
            timestamp: new Date().toISOString(),
          }),
        );
      }, 'Health check failed');
    },
  },
  onInit() {
    const dbPath = process.env.DB_PATH;
    if (dbPath) {
      try {
        db = new Database(dbPath, { readonly: true });
      } catch (err) {
        console.error('Health check: failed to open database:', err);
      }
    }
    signalCliUrl = process.env.SIGNAL_CLI_URL || '';
    signalAccount = process.env.SIGNAL_ACCOUNT || '';
    botStartTime = Number.parseInt(process.env.BOT_START_TIME || '0', 10) || 0;
  },
  onClose() {
    if (db) {
      db.close();
      db = null;
    }
  },
};

if (require.main === module) {
  runServer(healthCheckServer);
}
