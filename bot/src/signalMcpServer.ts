import fs from 'node:fs';
import path from 'node:path';
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
  {
    name: 'send_image',
    title: 'Send Image to Signal',
    description:
      'Send an image file as an attachment to the current Signal group chat. Use this after taking a screenshot with Playwright or when you need to share an image.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        imagePath: {
          type: 'string',
          description: 'Absolute path to the image file to send',
        },
        caption: {
          type: 'string',
          description: 'Optional caption text to accompany the image',
        },
      },
      required: ['imagePath'],
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

async function handleSendImage(args: Record<string, unknown>): Promise<ToolResult> {
  const imagePath = args.imagePath as string;
  const caption = args.caption as string | undefined;

  if (!imagePath || typeof imagePath !== 'string') {
    return { content: [{ type: 'text', text: 'Missing or invalid imagePath.' }], isError: true };
  }
  if (!fs.existsSync(imagePath)) {
    return { content: [{ type: 'text', text: `Image file not found: ${imagePath}` }], isError: true };
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
    // Read file and convert to data URI — signal-cli runs in Docker
    // and can't access host file paths, but accepts RFC 2397 data URIs
    const fileBuffer = fs.readFileSync(imagePath);
    const base64Data = fileBuffer.toString('base64');
    const ext = path.extname(imagePath).toLowerCase().replace('.', '');
    const mimeTypes: Record<string, string> = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
    };
    const mime = mimeTypes[ext] || 'application/octet-stream';
    const dataUri = `data:${mime};base64,${base64Data}`;

    const params: Record<string, unknown> = {
      account: SIGNAL_ACCOUNT,
      groupId: MCP_GROUP_ID,
      attachments: [dataUri],
    };
    if (caption) {
      params.message = caption;
    }

    const response = await fetch(`${SIGNAL_CLI_URL}/api/v1/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'send',
        params,
        id: `mcp-img-${Date.now()}`,
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

    return { content: [{ type: 'text', text: 'Image sent.' }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Failed to send image: ${getErrorMessage(error)}` }],
      isError: true,
    };
  }
}

async function handleToolCall(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  switch (name) {
    case 'send_message':
      return await handleSendMessage(args);
    case 'send_image':
      return await handleSendImage(args);
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
