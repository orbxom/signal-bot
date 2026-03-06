import { DatabaseConnection } from '../../db';
import { MemoryStore } from '../../stores/memoryStore';
import { readStorageEnv } from '../env';
import { catchErrors, estimateTokens, ok } from '../result';
import { runServer } from '../runServer';
import type { McpServerDefinition } from '../types';
import { requireGroupId, requireString } from '../validate';

const TOOLS = [
  {
    name: 'save_memory',
    title: 'Save Memory',
    description:
      'Save or update a group memory by topic. Content should be concise bullet points about the topic. Total content must stay under ~500 tokens (~2000 characters). Content REPLACES existing content entirely - always include all existing info plus new info.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        topic: {
          type: 'string',
          description: 'Short label for the memory, e.g. "holiday plans", "dietary restrictions"',
        },
        content: {
          type: 'string',
          description: 'The memory content. REPLACES existing content entirely.',
        },
      },
      required: ['topic', 'content'],
    },
  },
  {
    name: 'get_memory',
    title: 'Get Memory',
    description: 'Get a specific group memory by topic.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        topic: { type: 'string', description: 'The topic to look up' },
      },
      required: ['topic'],
    },
  },
  {
    name: 'list_memories',
    title: 'List Memories',
    description: 'List all saved memories for this group.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'delete_memory',
    title: 'Delete Memory',
    description: 'Delete a memory that is no longer relevant.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        topic: { type: 'string', description: 'The topic to delete' },
      },
      required: ['topic'],
    },
  },
];

let conn: DatabaseConnection;
let store: MemoryStore;
let groupId: string;

export const memoryServer: McpServerDefinition = {
  serverName: 'signal-bot-memories',
  configKey: 'memories',
  entrypoint: 'mcp/servers/memories',
  tools: TOOLS,
  envMapping: { DB_PATH: 'dbPath', MCP_GROUP_ID: 'groupId', MCP_SENDER: 'sender' },
  handlers: {
    save_memory(args) {
      const topic = requireString(args, 'topic');
      if (topic.error) return topic.error;
      const content = requireString(args, 'content');
      if (content.error) return content.error;
      const groupErr = requireGroupId(groupId);
      if (groupErr) return groupErr;

      return catchErrors(() => {
        store.upsert(groupId, topic.value, content.value);
        return ok(`Saved memory "${topic.value}". Content: ~${estimateTokens(content.value)} tokens used.`);
      }, 'Failed to save memory');
    },

    get_memory(args) {
      const topic = requireString(args, 'topic');
      if (topic.error) return topic.error;
      const groupErr = requireGroupId(groupId);
      if (groupErr) return groupErr;

      const memory = store.get(groupId, topic.value);
      if (!memory) {
        return ok(`No memory found for topic "${topic.value}" in this group.`);
      }

      const tokenCount = estimateTokens(memory.content);
      return ok(`Memory: ${memory.topic}\nContent (~${tokenCount} tokens):\n${memory.content}`);
    },

    list_memories() {
      const groupErr = requireGroupId(groupId);
      if (groupErr) return groupErr;

      const memories = store.getByGroup(groupId);
      if (memories.length === 0) {
        return ok('No memories found for this group.');
      }

      const lines = memories.map(m => `- **${m.topic}**: ${m.content}`);
      return ok(`Group memories:\n${lines.join('\n')}`);
    },

    delete_memory(args) {
      const topic = requireString(args, 'topic');
      if (topic.error) return topic.error;
      const groupErr = requireGroupId(groupId);
      if (groupErr) return groupErr;

      const deleted = store.delete(groupId, topic.value);
      if (!deleted) {
        return ok(`No memory found for topic "${topic.value}" to delete.`);
      }
      return ok(`Deleted memory "${topic.value}".`);
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
