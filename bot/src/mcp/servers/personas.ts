import { Storage } from '../../storage';
import { error, getErrorMessage, ok } from '../result';
import { runServer } from '../runServer';
import type { McpServerDefinition } from '../types';

const TOOLS = [
  {
    name: 'create_persona',
    title: 'Create Persona',
    description:
      'Create a new persona with a name, personality description, and optional tags. The description defines how the bot will behave when this persona is active. Do NOT create personas that are sexual, violent, target specific individuals, or attempt to bypass safety guidelines.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'A unique name for the persona' },
        description: {
          type: 'string',
          description: 'The personality prompt that defines how the bot behaves with this persona active',
        },
        tags: { type: 'string', description: 'Optional comma-separated tags for categorization' },
      },
      required: ['name', 'description'],
    },
  },
  {
    name: 'get_persona',
    title: 'Get Persona',
    description: 'Get details of a specific persona by its ID or name.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        identifier: { type: 'string', description: 'The persona ID (number) or name (string)' },
      },
      required: ['identifier'],
    },
  },
  {
    name: 'list_personas',
    title: 'List Personas',
    description: 'List all available personas and show which one is currently active for this group.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'update_persona',
    title: 'Update Persona',
    description: "Update an existing persona's name, description, or tags.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'number', description: 'The persona ID to update' },
        name: { type: 'string', description: 'New name for the persona' },
        description: { type: 'string', description: 'New personality description' },
        tags: { type: 'string', description: 'New comma-separated tags' },
      },
      required: ['id', 'name', 'description'],
    },
  },
  {
    name: 'delete_persona',
    title: 'Delete Persona',
    description:
      'Delete a persona by ID. Cannot delete the default persona. If the deleted persona is active for any group, those groups revert to the default.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'number', description: 'The persona ID to delete' },
      },
      required: ['id'],
    },
  },
  {
    name: 'switch_persona',
    title: 'Switch Persona',
    description:
      'Switch this group\'s active persona. Specify a persona by ID or name. Use "default" or "reset" to switch back to the default persona.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        identifier: {
          type: 'string',
          description: 'The persona ID, name, or "default"/"reset" to revert to the default',
        },
      },
      required: ['identifier'],
    },
  },
];

let storage: Storage;

function resolvePersona(identifier: string) {
  const idNum = Number(identifier);
  if (!Number.isNaN(idNum) && Number.isInteger(idNum) && idNum > 0) {
    return storage.getPersona(idNum);
  }
  return storage.getPersonaByName(identifier);
}

export const personaServer: McpServerDefinition = {
  serverName: 'signal-bot-personas',
  configKey: 'personas',
  entrypoint: 'mcp/servers/personas',
  tools: TOOLS,
  envMapping: { DB_PATH: 'dbPath', MCP_GROUP_ID: 'groupId', MCP_SENDER: 'sender' },
  handlers: {
    create_persona(args) {
      const name = args.name as string;
      const description = args.description as string;
      const tags = (args.tags as string) ?? '';

      if (!name || typeof name !== 'string') {
        return error('Missing or invalid name parameter.');
      }
      if (!description || typeof description !== 'string') {
        return error('Missing or invalid description parameter.');
      }

      try {
        const persona = storage.createPersona(name, description, tags);
        return ok(`Persona "${persona.name}" created (ID: ${persona.id}). ${tags ? `Tags: ${tags}` : ''}`);
      } catch (err) {
        return error(`Failed to create persona: ${getErrorMessage(err)}`);
      }
    },

    get_persona(args) {
      const identifier = args.identifier as string;

      if (!identifier || typeof identifier !== 'string') {
        return error('Missing or invalid identifier parameter.');
      }

      const persona = resolvePersona(identifier);
      if (!persona) {
        return error(`Persona "${identifier}" not found.`);
      }

      const lines = [
        `Name: ${persona.name} (ID: ${persona.id})`,
        `Description: ${persona.description}`,
        `Tags: ${persona.tags || '(none)'}`,
        `Default: ${persona.isDefault ? 'Yes' : 'No'}`,
      ];
      return ok(lines.join('\n'));
    },

    list_personas() {
      const groupId = process.env.MCP_GROUP_ID || '';
      const personas = storage.listPersonas();
      if (personas.length === 0) {
        return ok('No personas found.');
      }

      const active = groupId ? storage.getActivePersonaForGroup(groupId) : null;

      const lines = personas.map(p => {
        const isActive = active && active.id === p.id;
        const marker = isActive ? ' [ACTIVE]' : '';
        const defaultMarker = p.isDefault ? ' (default)' : '';
        const tags = p.tags ? ` [${p.tags}]` : '';
        return `- ${p.name}${defaultMarker}${marker}${tags} (ID: ${p.id})`;
      });

      return ok(`Available personas:\n${lines.join('\n')}`);
    },

    update_persona(args) {
      const id = args.id as number;
      const name = args.name as string;
      const description = args.description as string;
      const tags = (args.tags as string) ?? '';

      if (!id || typeof id !== 'number') {
        return error('Missing or invalid id parameter.');
      }
      if (!name || typeof name !== 'string') {
        return error('Missing or invalid name parameter.');
      }
      if (!description || typeof description !== 'string') {
        return error('Missing or invalid description parameter.');
      }

      try {
        const result = storage.updatePersona(id, name, description, tags);
        if (!result) {
          return error(`Persona with ID ${id} not found.`);
        }
        return ok(`Persona "${name}" (ID: ${id}) updated.`);
      } catch (err) {
        return error(`Failed to update persona: ${getErrorMessage(err)}`);
      }
    },

    delete_persona(args) {
      const id = args.id as number;

      if (!id || typeof id !== 'number') {
        return error('Missing or invalid id parameter.');
      }

      try {
        const result = storage.deletePersona(id);
        if (!result) {
          return error(`Cannot delete persona with ID ${id}. It may be the default persona or does not exist.`);
        }
        return ok(`Persona with ID ${id} deleted.`);
      } catch (err) {
        return error(`Failed to delete persona: ${getErrorMessage(err)}`);
      }
    },

    switch_persona(args) {
      const identifier = args.identifier as string;
      const groupId = process.env.MCP_GROUP_ID || '';

      if (!identifier || typeof identifier !== 'string') {
        return error('Missing or invalid identifier parameter.');
      }
      if (!groupId) {
        return error('No group context available.');
      }

      const lowerIdent = identifier.toLowerCase();
      if (lowerIdent === 'default' || lowerIdent === 'reset') {
        storage.clearActivePersona(groupId);
        const defaultPersona = storage.getDefaultPersona();
        const name = defaultPersona?.name ?? 'Default Assistant';
        return ok(`Persona switched to "${name}". I'll use this personality starting from the next message.`);
      }

      const persona = resolvePersona(identifier);
      if (!persona) {
        return error(`Persona "${identifier}" not found.`);
      }

      storage.setActivePersona(groupId, persona.id);
      return ok(`Persona switched to "${persona.name}". I'll use this personality starting from the next message.`);
    },
  },
  onInit() {
    const dbPath = process.env.DB_PATH || './data/bot.db';
    const groupId = process.env.MCP_GROUP_ID || '';
    const sender = process.env.MCP_SENDER || '';
    storage = new Storage(dbPath);
    console.error(`Persona MCP server started (group: ${groupId || 'none'}, sender: ${sender || 'none'})`);
  },
  onClose() {
    storage.close();
  },
};

if (require.main === module) {
  runServer(personaServer);
}
