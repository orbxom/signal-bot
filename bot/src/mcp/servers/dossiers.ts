import { Storage } from '../../storage';
import { error, estimateTokens, getErrorMessage, ok } from '../result';
import { runServer } from '../runServer';
import type { McpServerDefinition } from '../types';

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

let storage: Storage;

export const dossierServer: McpServerDefinition = {
  serverName: 'signal-bot-dossiers',
  configKey: 'dossiers',
  entrypoint: 'mcp/servers/dossiers',
  tools: TOOLS,
  envMapping: { DB_PATH: 'dbPath', MCP_GROUP_ID: 'groupId', MCP_SENDER: 'sender' },
  handlers: {
    update_dossier(args) {
      const personId = args.personId as string;
      const displayName = args.displayName as string;
      const notes = (args.notes as string) ?? '';
      const groupId = process.env.MCP_GROUP_ID || '';

      if (!personId || typeof personId !== 'string') {
        return error('Missing or invalid personId parameter.');
      }
      if (!displayName || typeof displayName !== 'string') {
        return error('Missing or invalid displayName parameter.');
      }
      if (!groupId) {
        return error('No group context available.');
      }

      try {
        storage.upsertDossier(groupId, personId, displayName, notes);
        return ok(`Updated dossier for ${displayName} (${personId}). Notes: ~${estimateTokens(notes)} tokens used.`);
      } catch (err) {
        return error(`Failed to update dossier: ${getErrorMessage(err)}`);
      }
    },

    get_dossier(args) {
      const personId = args.personId as string;
      const groupId = process.env.MCP_GROUP_ID || '';

      if (!personId || typeof personId !== 'string') {
        return error('Missing or invalid personId parameter.');
      }
      if (!groupId) {
        return error('No group context available.');
      }

      const dossier = storage.getDossier(groupId, personId);
      if (!dossier) {
        return ok(`No dossier found for ${personId} in this group.`);
      }

      const tokenCount = estimateTokens(dossier.notes);
      return ok(
        `Dossier for ${dossier.displayName} (${dossier.personId}):\nNotes (~${tokenCount} tokens):\n${dossier.notes}`,
      );
    },

    list_dossiers() {
      const groupId = process.env.MCP_GROUP_ID || '';
      if (!groupId) {
        return error('No group context available.');
      }

      const dossiers = storage.getDossiersByGroup(groupId);
      if (dossiers.length === 0) {
        return ok('No dossiers found for this group.');
      }

      const lines = dossiers.map(d => `- ${d.displayName} (${d.personId}): ${d.notes}`);
      return ok(`Known people in this group:\n${lines.join('\n')}`);
    },
  },
  onInit() {
    const dbPath = process.env.DB_PATH || './data/bot.db';
    const groupId = process.env.MCP_GROUP_ID || '';
    const sender = process.env.MCP_SENDER || '';
    storage = new Storage(dbPath);
    console.error(`Dossier MCP server started (group: ${groupId || 'none'}, sender: ${sender || 'none'})`);
  },
  onClose() {
    storage.close();
  },
};

if (require.main === module) {
  runServer(dossierServer);
}
