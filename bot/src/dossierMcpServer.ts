import * as readline from 'node:readline';
import { Storage } from './storage';

const PROTOCOL_VERSION = '2025-03-26';

const dbPath = process.env.DB_PATH || './data/bot.db';
const groupId = process.env.MCP_GROUP_ID || '';
const sender = process.env.MCP_SENDER || '';

let storage: Storage;

const TOOLS = [
  {
    name: 'update_dossier',
    title: 'Update Dossier',
    description:
      "Update or create a person's dossier with their display name and notes. Notes should be concise bullet points about the person. Total notes must stay under ~1000 tokens (~4000 characters). Notes REPLACE existing content entirely - always include all existing info plus new info.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        personId: { type: 'string', description: "The person's phone number or Signal ID" },
        displayName: { type: 'string', description: "The person's real name or nickname" },
        notes: { type: 'string', description: 'Updated notes about the person. REPLACES existing notes entirely.' },
      },
      required: ['personId', 'displayName', 'notes'],
    },
  },
  {
    name: 'get_dossier',
    title: 'Get Dossier',
    description: "Get a specific person's dossier including their display name and notes.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        personId: { type: 'string', description: "The person's phone number or Signal ID" },
      },
      required: ['personId'],
    },
  },
  {
    name: 'list_dossiers',
    title: 'List Dossiers',
    description: 'List all known people and their dossiers for this group.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
];

function handleUpdateDossier(args: Record<string, unknown>): {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
} {
  const personId = args.personId as string;
  const displayName = args.displayName as string;
  const notes = (args.notes as string) ?? '';

  if (!personId || typeof personId !== 'string') {
    return { content: [{ type: 'text', text: 'Missing or invalid personId parameter.' }], isError: true };
  }
  if (!displayName || typeof displayName !== 'string') {
    return { content: [{ type: 'text', text: 'Missing or invalid displayName parameter.' }], isError: true };
  }
  if (!groupId) {
    return { content: [{ type: 'text', text: 'No group context available.' }], isError: true };
  }

  try {
    storage.upsertDossier(groupId, personId, displayName, notes);
    return {
      content: [
        {
          type: 'text',
          text: `Updated dossier for ${displayName} (${personId}). Notes: ~${Math.ceil(notes.length / 4)} tokens used.`,
        },
      ],
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return { content: [{ type: 'text', text: `Failed to update dossier: ${msg}` }], isError: true };
  }
}

function handleGetDossier(args: Record<string, unknown>): {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
} {
  const personId = args.personId as string;

  if (!personId || typeof personId !== 'string') {
    return { content: [{ type: 'text', text: 'Missing or invalid personId parameter.' }], isError: true };
  }
  if (!groupId) {
    return { content: [{ type: 'text', text: 'No group context available.' }], isError: true };
  }

  const dossier = storage.getDossier(groupId, personId);
  if (!dossier) {
    return { content: [{ type: 'text', text: `No dossier found for ${personId} in this group.` }] };
  }

  const tokenCount = Math.ceil(dossier.notes.length / 4);
  return {
    content: [
      {
        type: 'text',
        text: `Dossier for ${dossier.displayName} (${dossier.personId}):\nNotes (~${tokenCount} tokens):\n${dossier.notes}`,
      },
    ],
  };
}

function handleListDossiers(): {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
} {
  if (!groupId) {
    return { content: [{ type: 'text', text: 'No group context available.' }], isError: true };
  }

  const dossiers = storage.getDossiersByGroup(groupId);
  if (dossiers.length === 0) {
    return { content: [{ type: 'text', text: 'No dossiers found for this group.' }] };
  }

  const lines = dossiers.map(d => `- ${d.displayName} (${d.personId}): ${d.notes}`);
  return { content: [{ type: 'text', text: `Known people in this group:\n${lines.join('\n')}` }] };
}

function handleToolCall(
  name: string,
  args: Record<string, unknown>,
): { content: Array<{ type: string; text: string }>; isError?: boolean } {
  switch (name) {
    case 'update_dossier':
      return handleUpdateDossier(args);
    case 'get_dossier':
      return handleGetDossier(args);
    case 'list_dossiers':
      return handleListDossiers();
    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
}

function handleMessage(msg: { id?: number | string; method: string; params?: Record<string, unknown> }): object | null {
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'signal-bot-dossiers', version: '1.0.0' },
        },
      };

    case 'notifications/initialized':
      // Notification — no response
      return null;

    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id,
        result: { tools: TOOLS },
      };

    case 'tools/call': {
      const toolName = (params?.name as string) || '';
      const toolArgs = (params?.arguments as Record<string, unknown>) || {};
      const result = handleToolCall(toolName, toolArgs);
      return { jsonrpc: '2.0', id, result };
    }

    default:
      // Unknown method
      if (id !== undefined) {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        };
      }
      // Unknown notification — ignore
      return null;
  }
}

function main() {
  storage = new Storage(dbPath);
  console.error(`Dossier MCP server started (group: ${groupId || 'none'}, sender: ${sender || 'none'})`);

  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  rl.on('line', (line: string) => {
    if (!line.trim()) return;

    try {
      const msg = JSON.parse(line);
      const response = handleMessage(msg);
      if (response) {
        process.stdout.write(`${JSON.stringify(response)}\n`);
      }
    } catch (error) {
      console.error('Error processing message:', error);
      // Send parse error
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`,
      );
    }
  });

  rl.on('close', () => {
    storage.close();
    process.exit(0);
  });
}

main();
