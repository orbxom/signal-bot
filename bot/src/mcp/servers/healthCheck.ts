import { ok } from '../result';
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
      return ok(JSON.stringify({ status: 'healthy' }));
    },
  },
  onInit() {},
  onClose() {},
};

if (require.main === module) {
  runServer(healthCheckServer);
}
