import { DatabaseConnection } from '../../db';
import { ReminderStore } from '../../stores/reminderStore';
import { readStorageEnv, readTimezone } from '../env';
import { catchErrors, error, ok } from '../result';
import { runServer } from '../runServer';
import type { McpServerDefinition } from '../types';
import { requireGroupId, requireNumber, requireString } from '../validate';

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

let conn: DatabaseConnection;
let store: ReminderStore;
let groupId: string;
let sender: string;
let tz: string;

export const reminderServer: McpServerDefinition = {
  serverName: 'signal-bot-reminders',
  configKey: 'reminders',
  entrypoint: 'mcp/servers/reminders',
  tools: TOOLS,
  envMapping: { DB_PATH: 'dbPath', MCP_GROUP_ID: 'groupId', MCP_SENDER: 'sender', TZ: 'timezone' },
  handlers: {
    set_reminder(args) {
      const reminderText = requireString(args, 'reminderText');
      if (reminderText.error) return reminderText.error;
      const dueAt = requireNumber(args, 'dueAt');
      if (dueAt.error) return dueAt.error;
      const groupErr = requireGroupId(groupId);
      if (groupErr) return groupErr;

      if (dueAt.value <= Date.now()) {
        return error('The reminder time must be in the future.');
      }

      return catchErrors(() => {
        const id = store.create(groupId, sender, reminderText.value, dueAt.value);
        const formatted = new Date(dueAt.value).toLocaleString('en-AU', { timeZone: tz });
        return ok(`Reminder #${id} set for ${formatted}: "${reminderText.value}"`);
      }, 'Failed to set reminder');
    },

    list_reminders() {
      if (!groupId) {
        return ok('No group context available.');
      }

      const reminders = store.listPending(groupId);
      if (reminders.length === 0) {
        return ok('No pending reminders for this group.');
      }

      const lines = reminders.map(r => {
        const due = new Date(r.dueAt).toLocaleString('en-AU', { timeZone: tz });
        return `#${r.id} | Due: ${due} | "${r.reminderText}" (set by ${r.requester})`;
      });
      return ok(`Pending reminders:\n${lines.join('\n')}`);
    },

    cancel_reminder(args) {
      const reminderId = requireNumber(args, 'reminderId');
      if (reminderId.error) return reminderId.error;
      const groupErr = requireGroupId(groupId);
      if (groupErr) return groupErr;

      const success = store.cancel(reminderId.value, groupId);
      if (success) {
        return ok(`Reminder #${reminderId.value} has been cancelled.`);
      }
      return ok(
        `Could not cancel reminder #${reminderId.value}. It may not exist, belong to a different group, or already be sent/cancelled.`,
      );
    },
  },
  onInit() {
    const env = readStorageEnv();
    conn = new DatabaseConnection(env.dbPath);
    store = new ReminderStore(conn);
    groupId = env.groupId;
    sender = env.sender;
    tz = readTimezone();
    console.error(`Reminder MCP server started (group: ${groupId || 'none'}, sender: ${sender || 'none'})`);
  },
  onClose() {
    conn.close();
  },
};

if (require.main === module) {
  runServer(reminderServer);
}
