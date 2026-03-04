import * as readline from 'node:readline';
import { error } from './result';
import type { McpServerDefinition } from './types';

const MCP_PROTOCOL_VERSION = '2025-03-26';

export function runServer(definition: McpServerDefinition): void {
  const { serverName, tools, handlers, onInit, onClose } = definition;

  async function handleMessage(msg: {
    id?: number | string;
    method: string;
    params?: Record<string, unknown>;
  }): Promise<object | null> {
    const { id, method, params } = msg;

    switch (method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: serverName, version: '1.0.0' },
          },
        };

      case 'notifications/initialized':
        return null;

      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id,
          result: { tools },
        };

      case 'tools/call': {
        const toolName = (params?.name as string) || '';
        const toolArgs = (params?.arguments as Record<string, unknown>) || {};
        const handler = handlers[toolName];
        if (!handler) {
          return { jsonrpc: '2.0', id, result: error(`Unknown tool: ${toolName}`) };
        }
        const result = await handler(toolArgs);
        return { jsonrpc: '2.0', id, result };
      }

      default:
        if (id !== undefined) {
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `Method not found: ${method}` },
          };
        }
        return null;
    }
  }

  onInit?.();

  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  rl.on('line', async (line: string) => {
    if (!line.trim()) return;

    try {
      const msg = JSON.parse(line);
      const response = await handleMessage(msg);
      if (response) {
        process.stdout.write(`${JSON.stringify(response)}\n`);
      }
    } catch (err) {
      console.error('Error processing message:', err);
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`,
      );
    }
  });

  rl.on('close', () => {
    onClose?.();
    process.exit(0);
  });
}
