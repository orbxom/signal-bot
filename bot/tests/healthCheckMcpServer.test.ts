import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseConnection } from '../src/db';
import { initializeServer, sendAndReceive, spawnMcpServer as spawnServer } from './helpers/mcpTestHelpers';

describe('Health Check MCP Server', () => {
  let testDir: string;
  let dbPath: string;
  let proc: ChildProcess | null = null;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'health-check-test-'));
    dbPath = join(testDir, 'test.db');
    // Create a real SQLite database so the health check can connect
    const dbConn = new DatabaseConnection(dbPath);
    dbConn.close();
  });

  afterEach(() => {
    if (proc) {
      proc.kill();
      proc = null;
    }
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  function spawnHealthCheckServer(env: Record<string, string> = {}): ChildProcess {
    const p = spawnServer('mcp/servers/healthCheck.ts', {
      DB_PATH: dbPath,
      SIGNAL_CLI_URL: 'http://localhost:19999',
      SIGNAL_ACCOUNT: '+61400000000',
      BOT_START_TIME: (Date.now() - 60000).toString(),
      ...env,
    });
    proc = p;
    return p;
  }

  it('should list the health_check tool', async () => {
    const server = spawnHealthCheckServer();
    try {
      await initializeServer(server);
      const response = await sendAndReceive(server, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
      });

      const result = response.result as {
        tools: Array<{ name: string }>;
      };
      expect(result.tools).toHaveLength(1);
      expect(result.tools[0].name).toBe('health_check');
    } finally {
      server.kill();
      proc = null;
    }
  }, 15000);

  it('should return structured health status via tools/call', async () => {
    const server = spawnHealthCheckServer();
    try {
      await initializeServer(server);
      const response = await sendAndReceive(server, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'health_check',
          arguments: {},
        },
      });

      const result = response.result as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };
      expect(result.isError).toBeFalsy();

      const health = JSON.parse(result.content[0].text);

      // Check top-level status
      expect(health.status).toBeDefined();
      expect(typeof health.status).toBe('string');

      // Check database status
      expect(health.database).toBeDefined();
      expect(health.database.status).toBe('ok');

      // Check uptime (should be ~60 seconds since we set BOT_START_TIME to 60s ago)
      expect(health.uptime).toBeDefined();
      expect(typeof health.uptime).toBe('number');
      expect(health.uptime).toBeGreaterThan(50);
      expect(health.uptime).toBeLessThan(120);

      // Check memory
      expect(health.memory).toBeDefined();
      expect(health.memory.heapUsed).toBeGreaterThan(0);
      expect(health.memory.rss).toBeGreaterThan(0);

      // Check MCP registry
      expect(health.mcp).toBeDefined();
      expect(health.mcp.registeredServers).toBeGreaterThan(0);
      expect(health.mcp.registeredTools).toBeGreaterThan(0);

      // Check timestamp
      expect(health.timestamp).toBeDefined();
      expect(typeof health.timestamp).toBe('string');
      // Should be a valid ISO date
      expect(() => new Date(health.timestamp)).not.toThrow();
    } finally {
      server.kill();
      proc = null;
    }
  }, 15000);
});
