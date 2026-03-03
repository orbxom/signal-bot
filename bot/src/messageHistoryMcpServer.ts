import { getErrorMessage, runMcpServer, type ToolResult } from './mcpServerBase';
import { Storage } from './storage';
import type { Message } from './types';

const dbPath = process.env.DB_PATH || './data/bot.db';
const groupId = process.env.MCP_GROUP_ID || '';
const tz = process.env.TZ || 'Australia/Sydney';

let storage: Storage;

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

// Use same YYYY-MM-DD HH:MM format as the conversation context timestamps
const timestampFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: tz,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

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

function handleSearchMessages(args: Record<string, unknown>): ToolResult {
  const keyword = args.keyword as string;
  if (!keyword || typeof keyword !== 'string') {
    return { content: [{ type: 'text', text: 'Missing or invalid keyword parameter.' }], isError: true };
  }
  if (!groupId) {
    return { content: [{ type: 'text', text: 'No group context available.' }], isError: true };
  }

  try {
    const options: { sender?: string; startTimestamp?: number; endTimestamp?: number } = {};

    if (args.sender && typeof args.sender === 'string') {
      options.sender = args.sender;
    }
    if (args.startDate && typeof args.startDate === 'string') {
      const parsed = new Date(args.startDate);
      if (Number.isNaN(parsed.getTime())) {
        return { content: [{ type: 'text', text: 'Invalid startDate format.' }], isError: true };
      }
      options.startTimestamp = parsed.getTime();
    }
    if (args.endDate && typeof args.endDate === 'string') {
      const parsed = new Date(args.endDate);
      if (Number.isNaN(parsed.getTime())) {
        return { content: [{ type: 'text', text: 'Invalid endDate format.' }], isError: true };
      }
      options.endTimestamp = parsed.getTime();
    }

    const messages = storage.searchMessages(groupId, keyword, options);
    return { content: [{ type: 'text', text: formatMessages(messages) }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Search failed: ${getErrorMessage(error)}` }], isError: true };
  }
}

function handleGetMessagesByDate(args: Record<string, unknown>): ToolResult {
  const startDate = args.startDate as string;
  if (!startDate || typeof startDate !== 'string') {
    return { content: [{ type: 'text', text: 'Missing or invalid startDate parameter.' }], isError: true };
  }
  if (!groupId) {
    return { content: [{ type: 'text', text: 'No group context available.' }], isError: true };
  }

  try {
    const startParsed = new Date(startDate);
    if (Number.isNaN(startParsed.getTime())) {
      return { content: [{ type: 'text', text: 'Invalid startDate format.' }], isError: true };
    }
    const startTs = startParsed.getTime();

    let endTs = Date.now();
    if (args.endDate && typeof args.endDate === 'string') {
      const endParsed = new Date(args.endDate);
      if (Number.isNaN(endParsed.getTime())) {
        return { content: [{ type: 'text', text: 'Invalid endDate format.' }], isError: true };
      }
      endTs = endParsed.getTime();
    }

    const messages = storage.getMessagesByDateRange(groupId, startTs, endTs);
    return { content: [{ type: 'text', text: formatMessages(messages) }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Failed to get messages: ${getErrorMessage(error)}` }], isError: true };
  }
}

function handleToolCall(name: string, args: Record<string, unknown>): ToolResult {
  switch (name) {
    case 'search_messages':
      return handleSearchMessages(args);
    case 'get_messages_by_date':
      return handleGetMessagesByDate(args);
    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
}

runMcpServer({
  name: 'signal-bot-message-history',
  tools: TOOLS,
  handleToolCall,
  onInit() {
    storage = new Storage(dbPath);
    console.error(`Message History MCP server started (group: ${groupId || 'none'})`);
  },
  onClose() {
    storage.close();
  },
});
