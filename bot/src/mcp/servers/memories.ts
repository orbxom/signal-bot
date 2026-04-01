import { DatabaseConnection } from '../../db';
import { MemoryStore } from '../../stores/memoryStore';
import type { MemoryWithTags } from '../../types';
import { readStorageEnv } from '../env';
import { withNotification } from '../notify';
import { estimateTokens, ok } from '../result';
import { runServer } from '../runServer';
import type { McpServerDefinition } from '../types';
import { optionalString, requireGroupId, requireNumber, requireString } from '../validate';

function formatMemory(m: MemoryWithTags): string {
  const lines = [`#${m.id} "${m.title}" [${m.type}]`];
  if (m.description) lines.push(`  Description: ${m.description}`);
  if (m.content) lines.push(`  Content: ${m.content}`);
  if (m.tags.length > 0) lines.push(`  Tags: ${m.tags.join(', ')}`);
  return lines.join('\n');
}

function tokenReport(description?: string | null, content?: string | null): string {
  const parts: string[] = [];
  if (description) parts.push(`description: ~${estimateTokens(description)} tokens`);
  if (content) parts.push(`content: ~${estimateTokens(content)} tokens`);
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

const TOOLS = [
  {
    name: 'save_memory',
    title: 'Save Memory',
    description:
      'Save a new memory or update an existing one (matched by title). Supports type classification, optional description, content, and tags.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Short label for the memory, e.g. "holiday plans"' },
        type: { type: 'string', description: 'Memory type, e.g. "event", "preference", "note", "fact"' },
        description: { type: 'string', description: 'Optional brief description' },
        content: { type: 'string', description: 'Optional detailed content' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional list of tags' },
      },
      required: ['title', 'type'],
    },
  },
  {
    name: 'update_memory',
    title: 'Update Memory',
    description: 'Update fields of an existing memory by its numeric ID.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'number', description: 'Numeric memory ID' },
        title: { type: 'string', description: 'New title' },
        type: { type: 'string', description: 'New type' },
        description: { type: 'string', description: 'New description' },
        content: { type: 'string', description: 'New content' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Replace all tags' },
      },
      required: ['id'],
    },
  },
  {
    name: 'get_memory',
    title: 'Get Memory',
    description: 'Retrieve a specific memory by its numeric ID.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'number', description: 'Numeric memory ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'search_memories',
    title: 'Search Memories',
    description: 'Search memories by keyword, type, or tag.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        keyword: { type: 'string', description: 'Search in title, description, and content' },
        type: { type: 'string', description: 'Filter by memory type' },
        tag: { type: 'string', description: 'Filter by tag' },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
    },
  },
  {
    name: 'list_types',
    title: 'List Types',
    description: 'List all distinct memory types used in this group.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'list_tags',
    title: 'List Tags',
    description: 'List all distinct tags used in this group.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'delete_memory',
    title: 'Delete Memory',
    description: 'Delete a memory by its numeric ID.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'number', description: 'Numeric memory ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'manage_tags',
    title: 'Manage Tags',
    description: 'Add or remove tags from an existing memory without replacing all tags.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'number', description: 'Numeric memory ID' },
        add: { type: 'array', items: { type: 'string' }, description: 'Tags to add' },
        remove: { type: 'array', items: { type: 'string' }, description: 'Tags to remove' },
      },
      required: ['id'],
    },
  },
];

let conn: DatabaseConnection;
let store: MemoryStore;
let groupId: string;

export const memoryServer: McpServerDefinition = {
  serverName: 'signal-bot-memories',
  configKey: 'memories',
  entrypoint: 'memories',
  tools: TOOLS,
  envMapping: { DB_PATH: 'dbPath', MCP_GROUP_ID: 'groupId', MCP_SENDER: 'sender' },
  handlers: {
    save_memory(args) {
      const title = requireString(args, 'title');
      if (title.error) return title.error;
      const type = requireString(args, 'type');
      if (type.error) return type.error;
      const groupErr = requireGroupId(groupId);
      if (groupErr) return groupErr;

      const description = args.description as string | undefined;
      const content = args.content as string | undefined;
      const tags = Array.isArray(args.tags) ? (args.tags as string[]) : undefined;

      return withNotification(
        `Memory saved: "${title.value}"`,
        'save memory',
        () => {
          const memory = store.save(groupId, title.value, type.value, { description, content, tags });
          return ok(`Saved memory${tokenReport(memory.description, memory.content)}:\n${formatMemory(memory)}`);
        },
        'Failed to save memory',
      );
    },

    update_memory(args) {
      const id = requireNumber(args, 'id');
      if (id.error) return id.error;

      const opts: { title?: string; description?: string; content?: string; type?: string; tags?: string[] } = {};
      if (typeof args.title === 'string') opts.title = args.title;
      if (typeof args.description === 'string') opts.description = args.description;
      if (typeof args.content === 'string') opts.content = args.content;
      if (typeof args.type === 'string') opts.type = args.type;
      if (Array.isArray(args.tags)) opts.tags = args.tags as string[];

      return withNotification(
        `Memory #${id.value} updated`,
        'update memory',
        () => {
          const memory = store.update(id.value, opts);
          if (!memory) {
            return ok(`Memory #${id.value} not found.`);
          }
          return ok(`Updated memory${tokenReport(memory.description, memory.content)}:\n${formatMemory(memory)}`);
        },
        'Failed to update memory',
      );
    },

    get_memory(args) {
      const id = requireNumber(args, 'id');
      if (id.error) return id.error;

      const memory = store.getById(id.value);
      if (!memory) {
        return ok(`Memory #${id.value} not found.`);
      }
      return ok(`${formatMemory(memory)}${tokenReport(memory.description, memory.content)}`);
    },

    search_memories(args) {
      const groupErr = requireGroupId(groupId);
      if (groupErr) return groupErr;

      const keyword = typeof args.keyword === 'string' ? args.keyword : undefined;
      const type = typeof args.type === 'string' ? args.type : undefined;
      const tag = typeof args.tag === 'string' ? args.tag : undefined;
      const limit = typeof args.limit === 'number' ? args.limit : 20;

      const memories = store.search(groupId, { keyword, type, tag }, limit);
      if (memories.length === 0) {
        return ok('No memories found.');
      }
      return ok(memories.map(m => formatMemory(m)).join('\n\n'));
    },

    list_types() {
      const groupErr = requireGroupId(groupId);
      if (groupErr) return groupErr;

      const types = store.listTypes(groupId);
      if (types.length === 0) {
        return ok('No memory types found.');
      }
      return ok(`Memory types: ${types.join(', ')}`);
    },

    list_tags() {
      const groupErr = requireGroupId(groupId);
      if (groupErr) return groupErr;

      const tags = store.listTags(groupId);
      if (tags.length === 0) {
        return ok('No tags found.');
      }
      return ok(`Tags: ${tags.join(', ')}`);
    },

    delete_memory(args) {
      const id = requireNumber(args, 'id');
      if (id.error) return id.error;

      return withNotification(
        `Memory #${id.value} deleted`,
        'delete memory',
        () => {
          const deleted = store.deleteById(id.value);
          if (!deleted) {
            return ok(`Memory #${id.value} not found.`);
          }
          return ok(`Deleted memory #${id.value}.`);
        },
        'Failed to delete memory',
      );
    },

    manage_tags(args) {
      const id = requireNumber(args, 'id');
      if (id.error) return id.error;

      const add = Array.isArray(args.add) ? (args.add as string[]) : [];
      const remove = Array.isArray(args.remove) ? (args.remove as string[]) : [];

      return withNotification(
        `Tags updated for memory #${id.value}`,
        'manage tags',
        () => {
          const memory = store.manageTags(id.value, add, remove);
          if (!memory) {
            return ok(`Memory #${id.value} not found.`);
          }
          return ok(`Tags updated:\n${formatMemory(memory)}`);
        },
        'Failed to manage tags',
      );
    },
  },
  onInit() {
    const env = readStorageEnv();
    conn = new DatabaseConnection(env.dbPath);
    store = new MemoryStore(conn);
    groupId = env.groupId;
    console.error(`Memory MCP server started (group: ${groupId || 'none'}, sender: ${env.sender || 'none'})`);
  },
  onClose() {
    conn.close();
  },
};

if (require.main === module) {
  runServer(memoryServer);
}
