import fs from 'node:fs';
import path from 'node:path';
import { catchErrors, error, ok } from '../result';
import { runServer } from '../runServer';
import type { McpServerDefinition } from '../types';
import { requireString } from '../validate';

const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB

let signalCliUrl = '';
let signalAccount = '';
let groupId = '';

async function signalRpc(method: string, params: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${signalCliUrl}/api/v1/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method,
      params: { account: signalAccount, ...params },
      id: `mcp-${Date.now()}`,
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Signal API error: ${response.statusText}`);
  const result = (await response.json()) as { error?: { message: string } };
  if (result.error) throw new Error(`Signal RPC error: ${result.error.message}`);
}

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
    send_message(args) {
      const msg = requireString(args, 'message');
      if (msg.error) return msg.error;

      if (!signalCliUrl) return error('SIGNAL_CLI_URL environment variable is not configured.');

      return catchErrors(async () => {
        await signalRpc('send', { groupId, message: msg.value });
        return ok('Message sent.');
      }, 'Failed to send message');
    },

    send_image(args) {
      const img = requireString(args, 'imagePath');
      if (img.error) return img.error;

      if (!signalCliUrl) return error('SIGNAL_CLI_URL environment variable is not configured.');

      return catchErrors(async () => {
        let stat: fs.Stats;
        try {
          stat = fs.statSync(img.value);
        } catch {
          return error(`Image file not found: ${img.value}`);
        }
        if (stat.size > MAX_IMAGE_SIZE) {
          const sizeMB = Math.round(stat.size / 1024 / 1024);
          return error(`Image file too large (${sizeMB}MB). Maximum size is 10MB.`);
        }

        const fileBuffer = fs.readFileSync(img.value);
        const base64Data = fileBuffer.toString('base64');
        const ext = path.extname(img.value).toLowerCase().replace('.', '');
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
          groupId,
          attachments: [dataUri],
        };
        const caption = typeof args.caption === 'string' ? args.caption : undefined;
        if (caption) {
          params.message = caption;
        }

        await signalRpc('send', params);
        return ok('Image sent.');
      }, 'Failed to send image');
    },
  },
  onInit() {
    signalCliUrl = process.env.SIGNAL_CLI_URL || '';
    signalAccount = process.env.SIGNAL_ACCOUNT || '';
    groupId = process.env.MCP_GROUP_ID || '';
    console.error(`Signal MCP server started (group: ${groupId})`);
  },
};

if (require.main === module) {
  runServer(signalServer);
}
