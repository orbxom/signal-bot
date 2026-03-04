import { Storage } from '../../storage';
import { error, getErrorMessage, ok } from '../result';
import { runServer } from '../runServer';
import type { McpServerDefinition } from '../types';

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

let storage: Storage;

export const reminderServer: McpServerDefinition = {
  serverName: 'signal-bot-reminders',
  configKey: 'reminders',
  entrypoint: 'mcp/servers/reminders',
  tools: TOOLS,
  envMapping: { DB_PATH: 'dbPath', MCP_GROUP_ID: 'groupId', MCP_SENDER: 'sender', TZ: 'timezone' },
  handlers: {
    set_reminder(args) {
      const reminderText = args.reminderText as string;
      const dueAt = args.dueAt as number;
      const groupId = process.env.MCP_GROUP_ID || '';
      const sender = process.env.MCP_SENDER || '';

      if (!reminderText || typeof reminderText !== 'string') {
        return error('Missing or invalid reminderText parameter.');
      }
      if (!dueAt || typeof dueAt !== 'number') {
        return error('Missing or invalid dueAt parameter.');
      }
      if (dueAt <= Date.now()) {
        return error('The reminder time must be in the future.');
      }
      if (!groupId) {
        return error('No group context available.');
      }

      try {
        const id = storage.createReminder(groupId, sender, reminderText, dueAt);
        const dueDate = new Date(dueAt);
        const formatted = dueDate.toLocaleString('en-AU', { timeZone: process.env.TZ || 'Australia/Sydney' });
        return ok(`Reminder #${id} set for ${formatted}: "${reminderText}"`);
      } catch (err) {
        return error(`Failed to set reminder: ${getErrorMessage(err)}`);
      }
    },

    list_reminders() {
      const groupId = process.env.MCP_GROUP_ID || '';
      if (!groupId) {
        return ok('No group context available.');
      }

      const reminders = storage.listReminders(groupId);
      if (reminders.length === 0) {
        return ok('No pending reminders for this group.');
      }

      const tz = process.env.TZ || 'Australia/Sydney';
      const lines = reminders.map(r => {
        const due = new Date(r.dueAt).toLocaleString('en-AU', { timeZone: tz });
        return `#${r.id} | Due: ${due} | "${r.reminderText}" (set by ${r.requester})`;
      });
      return ok(`Pending reminders:\n${lines.join('\n')}`);
    },

    cancel_reminder(args) {
      const reminderId = args.reminderId as number;
      const groupId = process.env.MCP_GROUP_ID || '';

      if (!reminderId || typeof reminderId !== 'number') {
        return error('Missing or invalid reminderId parameter.');
      }
      if (!groupId) {
        return error('No group context available.');
      }

      const success = storage.cancelReminder(reminderId, groupId);
      if (success) {
        return ok(`Reminder #${reminderId} has been cancelled.`);
      }
      return ok(
        `Could not cancel reminder #${reminderId}. It may not exist, belong to a different group, or already be sent/cancelled.`,
      );
    },
  },
  onInit() {
    const dbPath = process.env.DB_PATH || './data/bot.db';
    const groupId = process.env.MCP_GROUP_ID || '';
    const sender = process.env.MCP_SENDER || '';
    storage = new Storage(dbPath);
    console.error(`Reminder MCP server started (group: ${groupId || 'none'}, sender: ${sender || 'none'})`);
  },
  onClose() {
    storage.close();
  },
};

if (require.main === module) {
  runServer(reminderServer);
}
