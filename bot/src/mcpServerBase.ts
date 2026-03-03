import * as readline from 'node:readline';

export const MCP_PROTOCOL_VERSION = '2025-03-26';

export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function runMcpServer(config: {
  name: string;
  tools: unknown[];
  handleToolCall: (name: string, args: Record<string, unknown>) => ToolResult | Promise<ToolResult>;
  onInit?: () => void;
  onClose?: () => void;
}): void {
  const { name, tools, handleToolCall, onInit, onClose } = config;

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
            serverInfo: { name, version: '1.0.0' },
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
        const result = await handleToolCall(toolName, toolArgs);
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
    } catch (error) {
      console.error('Error processing message:', error);
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
