import * as readline from 'node:readline';
import { Storage } from './storage';

const PROTOCOL_VERSION = '2025-03-26';

const dbPath = process.env.DB_PATH || './data/bot.db';
const groupId = process.env.MCP_GROUP_ID || '';
const sender = process.env.MCP_SENDER || '';

let storage: Storage;

const TOOLS = [
  {
    name: 'set_reminder',
    title: 'Set Reminder',
    description:
      'Set a reminder that will be delivered to this Signal group chat at the specified time. Parse natural language time into a Unix millisecond timestamp before calling.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        reminderText: { type: 'string', description: 'The reminder message to deliver' },
        dueAt: {
          type: 'number',
          description: 'When to deliver the reminder, as a Unix timestamp in milliseconds',
        },
      },
      required: ['reminderText', 'dueAt'],
    },
  },
  {
    name: 'list_reminders',
    title: 'List Reminders',
    description: 'List all pending reminders for this Signal group chat.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'cancel_reminder',
    title: 'Cancel Reminder',
    description: 'Cancel a pending reminder by its ID.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        reminderId: { type: 'number', description: 'The ID of the reminder to cancel' },
      },
      required: ['reminderId'],
    },
  },
];

function handleSetReminder(args: Record<string, unknown>): {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
} {
  const reminderText = args.reminderText as string;
  const dueAt = args.dueAt as number;

  if (!reminderText || typeof reminderText !== 'string') {
    return { content: [{ type: 'text', text: 'Missing or invalid reminderText parameter.' }], isError: true };
  }
  if (!dueAt || typeof dueAt !== 'number') {
    return { content: [{ type: 'text', text: 'Missing or invalid dueAt parameter.' }], isError: true };
  }
  if (dueAt <= Date.now()) {
    return { content: [{ type: 'text', text: 'The reminder time must be in the future.' }], isError: true };
  }
  if (!groupId) {
    return { content: [{ type: 'text', text: 'No group context available.' }], isError: true };
  }

  try {
    const id = storage.createReminder(groupId, sender, reminderText, dueAt);
    const dueDate = new Date(dueAt);
    const formatted = dueDate.toLocaleString('en-AU', { timeZone: process.env.TZ || 'Australia/Sydney' });
    return { content: [{ type: 'text', text: `Reminder #${id} set for ${formatted}: "${reminderText}"` }] };
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return { content: [{ type: 'text', text: `Failed to set reminder: ${msg}` }], isError: true };
  }
}

function handleListReminders(): { content: Array<{ type: string; text: string }> } {
  if (!groupId) {
    return { content: [{ type: 'text', text: 'No group context available.' }] };
  }

  const reminders = storage.listReminders(groupId);
  if (reminders.length === 0) {
    return { content: [{ type: 'text', text: 'No pending reminders for this group.' }] };
  }

  const tz = process.env.TZ || 'Australia/Sydney';
  const lines = reminders.map(r => {
    const due = new Date(r.dueAt).toLocaleString('en-AU', { timeZone: tz });
    return `#${r.id} | Due: ${due} | "${r.reminderText}" (set by ${r.requester})`;
  });
  return { content: [{ type: 'text', text: `Pending reminders:\n${lines.join('\n')}` }] };
}

function handleCancelReminder(args: Record<string, unknown>): {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
} {
  const reminderId = args.reminderId as number;

  if (!reminderId || typeof reminderId !== 'number') {
    return { content: [{ type: 'text', text: 'Missing or invalid reminderId parameter.' }], isError: true };
  }
  if (!groupId) {
    return { content: [{ type: 'text', text: 'No group context available.' }], isError: true };
  }

  const success = storage.cancelReminder(reminderId, groupId);
  if (success) {
    return { content: [{ type: 'text', text: `Reminder #${reminderId} has been cancelled.` }] };
  }
  return {
    content: [
      {
        type: 'text',
        text: `Could not cancel reminder #${reminderId}. It may not exist, belong to a different group, or already be sent/cancelled.`,
      },
    ],
  };
}

function handleToolCall(
  name: string,
  args: Record<string, unknown>,
): { content: Array<{ type: string; text: string }>; isError?: boolean } {
  switch (name) {
    case 'set_reminder':
      return handleSetReminder(args);
    case 'list_reminders':
      return handleListReminders();
    case 'cancel_reminder':
      return handleCancelReminder(args);
    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
}

function handleMessage(msg: { id?: number | string; method: string; params?: Record<string, unknown> }): object | null {
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'signal-bot-reminders', version: '1.0.0' },
        },
      };

    case 'notifications/initialized':
      // Notification — no response
      return null;

    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id,
        result: { tools: TOOLS },
      };

    case 'tools/call': {
      const toolName = (params?.name as string) || '';
      const toolArgs = (params?.arguments as Record<string, unknown>) || {};
      const result = handleToolCall(toolName, toolArgs);
      return { jsonrpc: '2.0', id, result };
    }

    default:
      // Unknown method
      if (id !== undefined) {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        };
      }
      // Unknown notification — ignore
      return null;
  }
}

function main() {
  storage = new Storage(dbPath);
  console.error(`Reminder MCP server started (group: ${groupId || 'none'}, sender: ${sender || 'none'})`);

  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  rl.on('line', (line: string) => {
    if (!line.trim()) return;

    try {
      const msg = JSON.parse(line);
      const response = handleMessage(msg);
      if (response) {
        process.stdout.write(`${JSON.stringify(response)}\n`);
      }
    } catch (error) {
      console.error('Error processing message:', error);
      // Send parse error
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`,
      );
    }
  });

  rl.on('close', () => {
    storage.close();
    process.exit(0);
  });
}

main();
