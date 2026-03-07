import { DatabaseConnection } from '../../db';
import { RecurringReminderStore } from '../../stores/recurringReminderStore';
import { ReminderStore } from '../../stores/reminderStore';
import { computeNextDue, describeCron, isValidCron } from '../../utils/cron';
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
        mode: {
          type: 'string',
          enum: ['simple', 'prompt'],
          description:
            'Reminder mode: "simple" (default) sends the text as a message. "prompt" spawns a full Claude session with MCP tools to process the text as an instruction (use for tasks that need reasoning or tool access, e.g. "check the weather and report").',
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
  {
    name: 'set_recurring_reminder',
    title: 'Set Recurring Reminder',
    description:
      'Set a recurring reminder using a cron expression. The reminder will trigger a full Claude invocation each time it fires, so it can check weather, summarize reminders, etc. Examples: "0 8 * * *" = daily 8am, "0 16 * * 2" = Tuesday 4pm, "0 9 * * 1-5" = weekdays 9am.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        promptText: {
          type: 'string',
          description:
            'Instruction for what to do when the reminder fires (e.g., "Check the weather and give a morning briefing")',
        },
        cronExpression: {
          type: 'string',
          description: 'Cron expression (5-field: minute hour day month weekday)',
        },
      },
      required: ['promptText', 'cronExpression'],
    },
  },
  {
    name: 'list_recurring_reminders',
    title: 'List Recurring Reminders',
    description: 'List all active recurring reminders for this group.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'cancel_recurring_reminder',
    title: 'Cancel Recurring Reminder',
    description: 'Cancel a recurring reminder by its ID.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        reminderId: { type: 'number', description: 'The ID of the recurring reminder to cancel' },
      },
      required: ['reminderId'],
    },
  },
];

let conn: DatabaseConnection;
let store: ReminderStore;
let recurringStore: RecurringReminderStore;
let groupId: string;
let sender: string;
let tz: string;

export const reminderServer: McpServerDefinition = {
  serverName: 'signal-bot-reminders',
  configKey: 'reminders',
  entrypoint: 'reminders',
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

      const mode = args.mode as string | undefined;
      if (mode !== undefined && mode !== 'simple' && mode !== 'prompt') {
        return error(`Invalid mode: "${mode}". Must be "simple" or "prompt".`);
      }

      return catchErrors(() => {
        const id = store.create(groupId, sender, reminderText.value, dueAt.value, (mode as any) ?? 'simple');
        const formatted = new Date(dueAt.value).toLocaleString('en-AU', { timeZone: tz });
        const modeInfo = mode === 'prompt' ? ' (prompt mode — will spawn a Claude session)' : '';
        return ok(`Reminder #${id} set for ${formatted}: "${reminderText.value}"${modeInfo}`);
      }, 'Failed to set reminder');
    },

    list_reminders() {
      const groupErr = requireGroupId(groupId);
      if (groupErr) return groupErr;

      const reminders = store.listPending(groupId);
      if (reminders.length === 0) {
        return ok('No pending reminders for this group.');
      }

      const lines = reminders.map(r => {
        const due = new Date(r.dueAt).toLocaleString('en-AU', { timeZone: tz });
        const modeLabel = r.mode === 'prompt' ? ' [prompt]' : '';
        return `#${r.id} | Due: ${due}${modeLabel} | "${r.reminderText}" (set by ${r.requester})`;
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

    set_recurring_reminder(args) {
      const promptText = requireString(args, 'promptText');
      if (promptText.error) return promptText.error;
      const cronExpr = requireString(args, 'cronExpression');
      if (cronExpr.error) return cronExpr.error;
      const groupErr = requireGroupId(groupId);
      if (groupErr) return groupErr;

      if (!isValidCron(cronExpr.value)) {
        return error(
          `Invalid cron expression: "${cronExpr.value}". Use 5-field format: minute hour day month weekday.`,
        );
      }

      return catchErrors(() => {
        const nextDueAt = computeNextDue(cronExpr.value, tz);
        const id = recurringStore.create(groupId, sender, promptText.value, cronExpr.value, tz, nextDueAt);
        const desc = describeCron(cronExpr.value, tz);
        return ok(`Recurring reminder #${id} set (${cronExpr.value}).\n\nNext 3 occurrences:\n${desc}`);
      }, 'Failed to set recurring reminder');
    },

    list_recurring_reminders() {
      const groupErr = requireGroupId(groupId);
      if (groupErr) return groupErr;

      const reminders = recurringStore.listActive(groupId);
      if (reminders.length === 0) {
        return ok('No active recurring reminders for this group.');
      }

      const lines = reminders.map(r => {
        const next = new Date(r.nextDueAt).toLocaleString('en-AU', { timeZone: tz });
        return `#${r.id} | ${r.cronExpression} | Next: ${next} | "${r.promptText}" (by ${r.requester})`;
      });
      return ok(`Recurring reminders:\n${lines.join('\n')}`);
    },

    cancel_recurring_reminder(args) {
      const reminderId = requireNumber(args, 'reminderId');
      if (reminderId.error) return reminderId.error;
      const groupErr = requireGroupId(groupId);
      if (groupErr) return groupErr;

      const success = recurringStore.cancel(reminderId.value, groupId);
      if (success) {
        return ok(`Recurring reminder #${reminderId.value} has been cancelled.`);
      }
      return ok(
        `Could not cancel recurring reminder #${reminderId.value}. It may not exist, belong to a different group, or already be cancelled.`,
      );
    },
  },
  onInit() {
    const env = readStorageEnv();
    conn = new DatabaseConnection(env.dbPath);
    store = new ReminderStore(conn);
    recurringStore = new RecurringReminderStore(conn);
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
