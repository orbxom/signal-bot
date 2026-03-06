import { DatabaseConnection } from '../../db';
import { MessageStore } from '../../stores/messageStore';
import type { Message } from '../../types';
import { readStorageEnv, readTimezone } from '../env';
import { catchErrors, error, ok } from '../result';
import { runServer } from '../runServer';
import type { McpServerDefinition } from '../types';
import { requireGroupId, requireString } from '../validate';

const TOOLS = [
  {
    name: 'search_messages',
    title: 'Search Messages',
    description:
      'Search chat history for messages containing a keyword, with optional sender and date range filters. Returns up to 100 results.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        keyword: { type: 'string', description: 'The keyword to search for in message content' },
        sender: { type: 'string', description: 'Optional: filter by sender phone number or name' },
        startDate: {
          type: 'string',
          description: 'Optional: start of date range (ISO 8601 format)',
        },
        endDate: {
          type: 'string',
          description: 'Optional: end of date range (ISO 8601 format)',
        },
      },
      required: ['keyword'],
    },
  },
  {
    name: 'get_messages_by_date',
    title: 'Get Messages by Date',
    description: 'Retrieve all messages within a date range. Returns up to 200 results.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        startDate: {
          type: 'string',
          description: 'Start of date range (ISO 8601 format)',
        },
        endDate: {
          type: 'string',
          description: 'Optional: end of date range (ISO 8601 format). Defaults to now.',
        },
      },
      required: ['startDate'],
    },
  },
];

let conn: DatabaseConnection;
let store: MessageStore;
let groupId: string;
let timestampFormatter: Intl.DateTimeFormat;

function formatTimestamp(timestamp: number): string {
  const parts = timestampFormatter.formatToParts(new Date(timestamp));
  const get = (type: string) => parts.find(p => p.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

function formatMessages(messages: Message[]): string {
  if (messages.length === 0) {
    return 'No messages found.';
  }

  const lines = messages.map(msg => {
    const time = formatTimestamp(msg.timestamp);
    return `[${time}] ${msg.sender}: ${msg.content}`;
  });

  return `Found ${messages.length} message(s):\n${lines.join('\n')}`;
}

export const messageHistoryServer: McpServerDefinition = {
  serverName: 'signal-bot-message-history',
  configKey: 'history',
  entrypoint: 'mcp/servers/messageHistory',
  tools: TOOLS,
  envMapping: { DB_PATH: 'dbPath', MCP_GROUP_ID: 'groupId', TZ: 'timezone' },
  handlers: {
    search_messages(args) {
      const keyword = requireString(args, 'keyword');
      if (keyword.error) return keyword.error;
      const groupErr = requireGroupId(groupId);
      if (groupErr) return groupErr;

      return catchErrors(() => {
        const options: { sender?: string; startTimestamp?: number; endTimestamp?: number } = {};

        if (args.sender && typeof args.sender === 'string') {
          options.sender = args.sender;
        }
        if (args.startDate && typeof args.startDate === 'string') {
          const parsed = new Date(args.startDate);
          if (Number.isNaN(parsed.getTime())) {
            return error('Invalid startDate format.');
          }
          options.startTimestamp = parsed.getTime();
        }
        if (args.endDate && typeof args.endDate === 'string') {
          const parsed = new Date(args.endDate);
          if (Number.isNaN(parsed.getTime())) {
            return error('Invalid endDate format.');
          }
          options.endTimestamp = parsed.getTime();
        }

        const messages = store.search(groupId, keyword.value, options);
        return ok(formatMessages(messages));
      }, 'Search failed');
    },

    get_messages_by_date(args) {
      const startDate = requireString(args, 'startDate');
      if (startDate.error) return startDate.error;
      const groupErr = requireGroupId(groupId);
      if (groupErr) return groupErr;

      return catchErrors(() => {
        const startParsed = new Date(startDate.value);
        if (Number.isNaN(startParsed.getTime())) {
          return error('Invalid startDate format.');
        }
        const startTs = startParsed.getTime();

        let endTs = Date.now();
        if (args.endDate && typeof args.endDate === 'string') {
          const endParsed = new Date(args.endDate);
          if (Number.isNaN(endParsed.getTime())) {
            return error('Invalid endDate format.');
          }
          endTs = endParsed.getTime();
        }

        const messages = store.getByDateRange(groupId, startTs, endTs);
        return ok(formatMessages(messages));
      }, 'Failed to get messages');
    },
  },
  onInit() {
    const env = readStorageEnv();
    const tz = readTimezone();
    conn = new DatabaseConnection(env.dbPath);
    store = new MessageStore(conn);
    groupId = env.groupId;
    timestampFormatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    console.error(`Message History MCP server started (group: ${groupId || 'none'})`);
  },
  onClose() {
    conn.close();
  },
};

if (require.main === module) {
  runServer(messageHistoryServer);
}
