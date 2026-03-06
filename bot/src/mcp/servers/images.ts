import { DatabaseConnection } from '../../db';
import { AttachmentStore } from '../../stores/attachmentStore';
import { readStorageEnv } from '../env';
import { error } from '../result';
import { runServer } from '../runServer';
import type { McpServerDefinition, ToolResult } from '../types';
import { requireString } from '../validate';

let store: AttachmentStore | null = null;
let conn: DatabaseConnection | null = null;

const TOOLS = [
  {
    name: 'view_image',
    title: 'View Image Attachment',
    description:
      'View an image attachment from a Signal message. Pass the attachment ID from an [Image: attachment://<id>] reference in the conversation. Returns the image for visual analysis.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        attachmentId: {
          type: 'string',
          description: 'The attachment ID from an attachment:// URI in the conversation',
        },
      },
      required: ['attachmentId'],
    },
  },
];

export const imagesServer: McpServerDefinition = {
  serverName: 'signal-bot-images',
  configKey: 'images',
  entrypoint: 'images',
  tools: TOOLS,
  envMapping: { DB_PATH: 'dbPath' },
  handlers: {
    view_image(args): ToolResult {
      const id = requireString(args, 'attachmentId');
      if (id.error) return id.error;

      if (!store) return error('Image store not initialized.');

      const attachment = store.get(id.value);
      if (!attachment) return error(`Attachment not found: ${id.value}`);

      const base64Data = Buffer.isBuffer(attachment.data)
        ? attachment.data.toString('base64')
        : attachment.data;

      return {
        content: [
          { type: 'image', data: base64Data as string, mimeType: attachment.contentType },
          {
            type: 'text',
            text: `Image: ${attachment.filename || id.value} (${attachment.contentType}, ${Math.round(attachment.size / 1024)}KB)`,
          },
        ],
      };
    },
  },
  onInit() {
    const env = readStorageEnv();
    conn = new DatabaseConnection(env.dbPath);
    store = new AttachmentStore(conn);
    console.error('Images MCP server started');
  },
  onClose() {
    conn?.close();
  },
};

if (require.main === module) {
  runServer(imagesServer);
}
