import { DatabaseConnection } from '../../db';
import { PersonaStore } from '../../stores/personaStore';
import { readStorageEnv } from '../env';
import { withNotification } from '../notify';
import { error, ok, resultText } from '../result';
import { runServer } from '../runServer';
import type { McpServerDefinition } from '../types';
import { optionalString, requireGroupId, requireNumber, requireString } from '../validate';

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

let conn: DatabaseConnection;
let store: PersonaStore;
let groupId: string;

function resolvePersona(identifier: string) {
  const idNum = Number(identifier);
  if (!Number.isNaN(idNum) && Number.isInteger(idNum) && idNum > 0) {
    return store.getById(idNum);
  }
  return store.getByName(identifier);
}

export const personaServer: McpServerDefinition = {
  serverName: 'signal-bot-personas',
  configKey: 'personas',
  entrypoint: 'personas',
  tools: TOOLS,
  envMapping: { DB_PATH: 'dbPath', MCP_GROUP_ID: 'groupId', MCP_SENDER: 'sender' },
  handlers: {
    create_persona(args) {
      const name = requireString(args, 'name');
      if (name.error) return name.error;
      const description = requireString(args, 'description');
      if (description.error) return description.error;
      const tags = optionalString(args, 'tags', '');

      return withNotification(
        `Persona "${name.value}" created`,
        'create persona',
        () => {
          const persona = store.create(name.value, description.value, tags);
          return ok(`Persona "${persona.name}" created (ID: ${persona.id}). ${tags ? `Tags: ${tags}` : ''}`);
        },
        'Failed to create persona',
      );
    },

    get_persona(args) {
      const identifier = requireString(args, 'identifier');
      if (identifier.error) return identifier.error;

      const persona = resolvePersona(identifier.value);
      if (!persona) {
        return error(`Persona "${identifier.value}" not found.`);
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
      const groupErr = requireGroupId(groupId);
      if (groupErr) return groupErr;

      const personas = store.list();
      if (personas.length === 0) {
        return ok('No personas found.');
      }

      const active = store.getActiveForGroup(groupId);

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
      const id = requireNumber(args, 'id');
      if (id.error) return id.error;
      const name = requireString(args, 'name');
      if (name.error) return name.error;
      const description = requireString(args, 'description');
      if (description.error) return description.error;
      const tags = optionalString(args, 'tags', '');

      return withNotification(
        `Persona "${name.value}" updated`,
        'update persona',
        () => {
          const result = store.update(id.value, name.value, description.value, tags);
          if (!result) {
            return error(`Persona with ID ${id.value} not found.`);
          }
          return ok(`Persona "${name.value}" (ID: ${id.value}) updated.`);
        },
        'Failed to update persona',
      );
    },

    delete_persona(args) {
      const id = requireNumber(args, 'id');
      if (id.error) return id.error;

      return withNotification(
        `Persona #${id.value} deleted`,
        'delete persona',
        () => {
          const result = store.delete(id.value);
          if (!result) {
            return error(`Cannot delete persona with ID ${id.value}. It may be the default persona or does not exist.`);
          }
          return ok(`Persona with ID ${id.value} deleted.`);
        },
        'Failed to delete persona',
      );
    },

    switch_persona(args) {
      const identifier = requireString(args, 'identifier');
      if (identifier.error) return identifier.error;
      const groupErr = requireGroupId(groupId);
      if (groupErr) return groupErr;

      return withNotification(
        result => resultText(result).split('.')[0],
        'switch persona',
        () => {
          const lowerIdent = identifier.value.toLowerCase();
          if (lowerIdent === 'default' || lowerIdent === 'reset') {
            store.clearActive(groupId);
            const defaultPersona = store.getDefault();
            const name = defaultPersona?.name ?? 'Default Assistant';
            return ok(`Persona switched to "${name}". I'll use this personality starting from the next message.`);
          }

          const persona = resolvePersona(identifier.value);
          if (!persona) {
            return error(`Persona "${identifier.value}" not found.`);
          }

          store.setActive(groupId, persona.id);
          return ok(`Persona switched to "${persona.name}". I'll use this personality starting from the next message.`);
        },
        'Failed to switch persona',
      );
    },
  },
  onInit() {
    const env = readStorageEnv();
    conn = new DatabaseConnection(env.dbPath);
    store = new PersonaStore(conn);
    store.seedDefault();
    groupId = env.groupId;
    console.error(`Persona MCP server started (group: ${groupId || 'none'}, sender: ${env.sender || 'none'})`);
  },
  onClose() {
    conn.close();
  },
};

if (require.main === module) {
  runServer(personaServer);
}
