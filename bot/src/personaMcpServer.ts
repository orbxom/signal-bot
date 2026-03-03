import { getErrorMessage, runMcpServer, type ToolResult } from './mcpServerBase';
import { Storage } from './storage';

const dbPath = process.env.DB_PATH || './data/bot.db';
const groupId = process.env.MCP_GROUP_ID || '';
const sender = process.env.MCP_SENDER || '';

let storage: Storage;

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

function resolvePersona(identifier: string) {
  const idNum = Number(identifier);
  if (!Number.isNaN(idNum) && Number.isInteger(idNum) && idNum > 0) {
    return storage.getPersona(idNum);
  }
  return storage.getPersonaByName(identifier);
}

function handleCreatePersona(args: Record<string, unknown>): ToolResult {
  const name = args.name as string;
  const description = args.description as string;
  const tags = (args.tags as string) ?? '';

  if (!name || typeof name !== 'string') {
    return { content: [{ type: 'text', text: 'Missing or invalid name parameter.' }], isError: true };
  }
  if (!description || typeof description !== 'string') {
    return { content: [{ type: 'text', text: 'Missing or invalid description parameter.' }], isError: true };
  }

  try {
    const persona = storage.createPersona(name, description, tags);
    return {
      content: [
        {
          type: 'text',
          text: `Persona "${persona.name}" created (ID: ${persona.id}). ${tags ? `Tags: ${tags}` : ''}`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Failed to create persona: ${getErrorMessage(error)}` }],
      isError: true,
    };
  }
}

function handleGetPersona(args: Record<string, unknown>): ToolResult {
  const identifier = args.identifier as string;

  if (!identifier || typeof identifier !== 'string') {
    return { content: [{ type: 'text', text: 'Missing or invalid identifier parameter.' }], isError: true };
  }

  const persona = resolvePersona(identifier);
  if (!persona) {
    return { content: [{ type: 'text', text: `Persona "${identifier}" not found.` }], isError: true };
  }

  const lines = [
    `Name: ${persona.name} (ID: ${persona.id})`,
    `Description: ${persona.description}`,
    `Tags: ${persona.tags || '(none)'}`,
    `Default: ${persona.isDefault ? 'Yes' : 'No'}`,
  ];
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

function handleListPersonas(): ToolResult {
  const personas = storage.listPersonas();
  if (personas.length === 0) {
    return { content: [{ type: 'text', text: 'No personas found.' }] };
  }

  const active = groupId ? storage.getActivePersonaForGroup(groupId) : null;

  const lines = personas.map(p => {
    const isActive = active && active.id === p.id;
    const marker = isActive ? ' [ACTIVE]' : '';
    const defaultMarker = p.isDefault ? ' (default)' : '';
    const tags = p.tags ? ` [${p.tags}]` : '';
    return `- ${p.name}${defaultMarker}${marker}${tags} (ID: ${p.id})`;
  });

  return { content: [{ type: 'text', text: `Available personas:\n${lines.join('\n')}` }] };
}

function handleUpdatePersona(args: Record<string, unknown>): ToolResult {
  const id = args.id as number;
  const name = args.name as string;
  const description = args.description as string;
  const tags = (args.tags as string) ?? '';

  if (!id || typeof id !== 'number') {
    return { content: [{ type: 'text', text: 'Missing or invalid id parameter.' }], isError: true };
  }
  if (!name || typeof name !== 'string') {
    return { content: [{ type: 'text', text: 'Missing or invalid name parameter.' }], isError: true };
  }
  if (!description || typeof description !== 'string') {
    return { content: [{ type: 'text', text: 'Missing or invalid description parameter.' }], isError: true };
  }

  try {
    const result = storage.updatePersona(id, name, description, tags);
    if (!result) {
      return { content: [{ type: 'text', text: `Persona with ID ${id} not found.` }], isError: true };
    }
    return { content: [{ type: 'text', text: `Persona "${name}" (ID: ${id}) updated.` }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Failed to update persona: ${getErrorMessage(error)}` }],
      isError: true,
    };
  }
}

function handleDeletePersona(args: Record<string, unknown>): ToolResult {
  const id = args.id as number;

  if (!id || typeof id !== 'number') {
    return { content: [{ type: 'text', text: 'Missing or invalid id parameter.' }], isError: true };
  }

  try {
    const result = storage.deletePersona(id);
    if (!result) {
      return {
        content: [
          {
            type: 'text',
            text: `Cannot delete persona with ID ${id}. It may be the default persona or does not exist.`,
          },
        ],
        isError: true,
      };
    }
    return { content: [{ type: 'text', text: `Persona with ID ${id} deleted.` }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Failed to delete persona: ${getErrorMessage(error)}` }],
      isError: true,
    };
  }
}

function handleSwitchPersona(args: Record<string, unknown>): ToolResult {
  const identifier = args.identifier as string;

  if (!identifier || typeof identifier !== 'string') {
    return { content: [{ type: 'text', text: 'Missing or invalid identifier parameter.' }], isError: true };
  }
  if (!groupId) {
    return { content: [{ type: 'text', text: 'No group context available.' }], isError: true };
  }

  const lowerIdent = identifier.toLowerCase();
  if (lowerIdent === 'default' || lowerIdent === 'reset') {
    storage.clearActivePersona(groupId);
    const defaultPersona = storage.getDefaultPersona();
    const name = defaultPersona?.name ?? 'Default Assistant';
    return {
      content: [
        {
          type: 'text',
          text: `Persona switched to "${name}". I'll use this personality starting from the next message.`,
        },
      ],
    };
  }

  const persona = resolvePersona(identifier);
  if (!persona) {
    return { content: [{ type: 'text', text: `Persona "${identifier}" not found.` }], isError: true };
  }

  storage.setActivePersona(groupId, persona.id);
  return {
    content: [
      {
        type: 'text',
        text: `Persona switched to "${persona.name}". I'll use this personality starting from the next message.`,
      },
    ],
  };
}

function handleToolCall(name: string, args: Record<string, unknown>): ToolResult {
  switch (name) {
    case 'create_persona':
      return handleCreatePersona(args);
    case 'get_persona':
      return handleGetPersona(args);
    case 'list_personas':
      return handleListPersonas();
    case 'update_persona':
      return handleUpdatePersona(args);
    case 'delete_persona':
      return handleDeletePersona(args);
    case 'switch_persona':
      return handleSwitchPersona(args);
    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
}

runMcpServer({
  name: 'signal-bot-personas',
  tools: TOOLS,
  handleToolCall,
  onInit() {
    storage = new Storage(dbPath);
    console.error(`Persona MCP server started (group: ${groupId || 'none'}, sender: ${sender || 'none'})`);
  },
  onClose() {
    storage.close();
  },
});
