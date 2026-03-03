import { getErrorMessage, runMcpServer, type ToolResult } from './mcpServerBase';

const SIGNAL_CLI_URL = process.env.SIGNAL_CLI_URL || '';
const SIGNAL_ACCOUNT = process.env.SIGNAL_ACCOUNT || '';
const MCP_GROUP_ID = process.env.MCP_GROUP_ID || '';

const TOOLS = [
  {
    name: 'send_message',
    title: 'Send Signal Message',
    description:
      'Send a message to the current Signal group chat. Use this to acknowledge requests, provide progress updates, and send your final response. Always use this tool to communicate — do not just return text.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        message: {
          type: 'string',
          description: 'The message text to send to the group chat',
        },
      },
      required: ['message'],
    },
  },
];

async function handleSendMessage(args: Record<string, unknown>): Promise<ToolResult> {
  const message = args.message as string;

  if (!message || typeof message !== 'string') {
    return { content: [{ type: 'text', text: 'Missing or invalid message.' }], isError: true };
  }
  if (!SIGNAL_CLI_URL) {
    return {
      content: [{ type: 'text', text: 'SIGNAL_CLI_URL environment variable is not configured.' }],
      isError: true,
    };
  }
  if (!SIGNAL_ACCOUNT) {
    return {
      content: [{ type: 'text', text: 'SIGNAL_ACCOUNT environment variable is not configured.' }],
      isError: true,
    };
  }
  if (!MCP_GROUP_ID) {
    return {
      content: [{ type: 'text', text: 'MCP_GROUP_ID environment variable is not configured.' }],
      isError: true,
    };
  }

  try {
    const response = await fetch(`${SIGNAL_CLI_URL}/api/v1/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'send',
        params: {
          account: SIGNAL_ACCOUNT,
          groupId: MCP_GROUP_ID,
          message,
        },
        id: `mcp-${Date.now()}`,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      return {
        content: [{ type: 'text', text: `Signal API error: ${response.statusText}` }],
        isError: true,
      };
    }

    const result = (await response.json()) as { error?: { message: string } };
    if (result.error) {
      return {
        content: [{ type: 'text', text: `Signal RPC error: ${result.error.message}` }],
        isError: true,
      };
    }

    return { content: [{ type: 'text', text: 'Message sent.' }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Failed to send message: ${getErrorMessage(error)}` }],
      isError: true,
    };
  }
}

async function handleToolCall(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  switch (name) {
    case 'send_message':
      return await handleSendMessage(args);
    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
}

runMcpServer({
  name: 'signal-bot-signal',
  tools: TOOLS,
  handleToolCall,
  onInit() {
    console.error(`Signal MCP server started (group: ${MCP_GROUP_ID})`);
  },
});
