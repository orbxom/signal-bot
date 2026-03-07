import { DatabaseConnection } from '../../db';
import { DossierStore } from '../../stores/dossierStore';
import { readStorageEnv } from '../env';
import { withNotification } from '../notify';
import { estimateTokens, ok } from '../result';
import { runServer } from '../runServer';
import type { McpServerDefinition } from '../types';
import { optionalString, requireGroupId, requireString } from '../validate';

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

let conn: DatabaseConnection;
let store: DossierStore;
let groupId: string;

export const dossierServer: McpServerDefinition = {
  serverName: 'signal-bot-dossiers',
  configKey: 'dossiers',
  entrypoint: 'dossiers',
  tools: TOOLS,
  envMapping: { DB_PATH: 'dbPath', MCP_GROUP_ID: 'groupId' },
  handlers: {
    update_dossier(args) {
      const personId = requireString(args, 'personId');
      if (personId.error) return personId.error;
      const displayName = requireString(args, 'displayName');
      if (displayName.error) return displayName.error;
      const notes = optionalString(args, 'notes', '');
      const groupErr = requireGroupId(groupId);
      if (groupErr) return groupErr;

      return withNotification(
        `Dossier updated for ${displayName.value}`,
        'update dossier',
        () => {
          store.upsert(groupId, personId.value, displayName.value, notes);
          return ok(
            `Updated dossier for ${displayName.value} (${personId.value}). Notes: ~${estimateTokens(notes)} tokens used.`,
          );
        },
        'Failed to update dossier',
      );
    },

    get_dossier(args) {
      const personId = requireString(args, 'personId');
      if (personId.error) return personId.error;
      const groupErr = requireGroupId(groupId);
      if (groupErr) return groupErr;

      const dossier = store.get(groupId, personId.value);
      if (!dossier) {
        return ok(`No dossier found for ${personId.value} in this group.`);
      }

      const tokenCount = estimateTokens(dossier.notes);
      return ok(
        `Dossier for ${dossier.displayName} (${dossier.personId}):\nNotes (~${tokenCount} tokens):\n${dossier.notes}`,
      );
    },

    list_dossiers() {
      const groupErr = requireGroupId(groupId);
      if (groupErr) return groupErr;

      const dossiers = store.getByGroup(groupId);
      if (dossiers.length === 0) {
        return ok('No dossiers found for this group.');
      }

      const lines = dossiers.map(d => `- ${d.displayName} (${d.personId}): ${d.notes}`);
      return ok(`Known people in this group:\n${lines.join('\n')}`);
    },
  },
  onInit() {
    const env = readStorageEnv();
    conn = new DatabaseConnection(env.dbPath);
    store = new DossierStore(conn);
    groupId = env.groupId;
    console.error(`Dossier MCP server started (group: ${groupId || 'none'})`);
  },
  onClose() {
    conn.close();
  },
};

if (require.main === module) {
  runServer(dossierServer);
}
