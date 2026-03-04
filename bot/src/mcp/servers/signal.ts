import fs from 'node:fs';
import path from 'node:path';
import { error, getErrorMessage, ok } from '../result';
import { runServer } from '../runServer';
import type { McpServerDefinition } from '../types';

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

export const signalServer: McpServerDefinition = {
  serverName: 'signal-bot-signal',
  configKey: 'signal',
  entrypoint: 'mcp/servers/signal',
  tools: TOOLS,
  envMapping: { SIGNAL_CLI_URL: 'signalCliUrl', SIGNAL_ACCOUNT: 'botPhoneNumber', MCP_GROUP_ID: 'groupId' },
  handlers: {
    async send_message(args) {
      const message = args.message as string;
      const SIGNAL_CLI_URL = process.env.SIGNAL_CLI_URL || '';
      const SIGNAL_ACCOUNT = process.env.SIGNAL_ACCOUNT || '';
      const MCP_GROUP_ID = process.env.MCP_GROUP_ID || '';

      if (!message || typeof message !== 'string') {
        return error('Missing or invalid message.');
      }
      if (!SIGNAL_CLI_URL) {
        return error('SIGNAL_CLI_URL environment variable is not configured.');
      }
      if (!SIGNAL_ACCOUNT) {
        return error('SIGNAL_ACCOUNT environment variable is not configured.');
      }
      if (!MCP_GROUP_ID) {
        return error('MCP_GROUP_ID environment variable is not configured.');
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
          return error(`Signal API error: ${response.statusText}`);
        }

        const result = (await response.json()) as { error?: { message: string } };
        if (result.error) {
          return error(`Signal RPC error: ${result.error.message}`);
        }

        return ok('Message sent.');
      } catch (err) {
        return error(`Failed to send message: ${getErrorMessage(err)}`);
      }
    },

    async send_image(args) {
      const imagePath = args.imagePath as string;
      const caption = args.caption as string | undefined;
      const SIGNAL_CLI_URL = process.env.SIGNAL_CLI_URL || '';
      const SIGNAL_ACCOUNT = process.env.SIGNAL_ACCOUNT || '';
      const MCP_GROUP_ID = process.env.MCP_GROUP_ID || '';

      if (!imagePath || typeof imagePath !== 'string') {
        return error('Missing or invalid imagePath.');
      }
      if (!fs.existsSync(imagePath)) {
        return error(`Image file not found: ${imagePath}`);
      }
      if (!SIGNAL_CLI_URL) {
        return error('SIGNAL_CLI_URL environment variable is not configured.');
      }
      if (!SIGNAL_ACCOUNT) {
        return error('SIGNAL_ACCOUNT environment variable is not configured.');
      }
      if (!MCP_GROUP_ID) {
        return error('MCP_GROUP_ID environment variable is not configured.');
      }

      try {
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
          return error(`Signal API error: ${response.statusText}`);
        }

        const result = (await response.json()) as { error?: { message: string } };
        if (result.error) {
          return error(`Signal RPC error: ${result.error.message}`);
        }

        return ok('Image sent.');
      } catch (err) {
        return error(`Failed to send image: ${getErrorMessage(err)}`);
      }
    },
  },
  onInit() {
    const MCP_GROUP_ID = process.env.MCP_GROUP_ID || '';
    console.error(`Signal MCP server started (group: ${MCP_GROUP_ID})`);
  },
};

if (require.main === module) {
  runServer(signalServer);
}
