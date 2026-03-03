import { estimateTokens, getErrorMessage, runMcpServer, type ToolResult } from './mcpServerBase';
import { Storage } from './storage';

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

function handleUpdateDossier(args: Record<string, unknown>): ToolResult {
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
          text: `Updated dossier for ${displayName} (${personId}). Notes: ~${estimateTokens(notes)} tokens used.`,
        },
      ],
    };
  } catch (error) {
    return { content: [{ type: 'text', text: `Failed to update dossier: ${getErrorMessage(error)}` }], isError: true };
  }
}

function handleGetDossier(args: Record<string, unknown>): ToolResult {
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

  const tokenCount = estimateTokens(dossier.notes);
  return {
    content: [
      {
        type: 'text',
        text: `Dossier for ${dossier.displayName} (${dossier.personId}):\nNotes (~${tokenCount} tokens):\n${dossier.notes}`,
      },
    ],
  };
}

function handleListDossiers(): ToolResult {
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

function handleToolCall(name: string, args: Record<string, unknown>): ToolResult {
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

runMcpServer({
  name: 'signal-bot-dossiers',
  tools: TOOLS,
  handleToolCall,
  onInit() {
    storage = new Storage(dbPath);
    console.error(`Dossier MCP server started (group: ${groupId || 'none'}, sender: ${sender || 'none'})`);
  },
  onClose() {
    storage.close();
  },
});
