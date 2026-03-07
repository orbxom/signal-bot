import { DatabaseConnection } from '../../db';
import { ToolNotificationStore } from '../../stores/toolNotificationStore';
import { readStorageEnv } from '../env';
import { catchErrors, ok } from '../result';
import { runServer } from '../runServer';
import type { McpServerDefinition } from '../types';
import { requireString } from '../validate';

const TOOLS = [
  {
    name: 'toggle_tool_notifications',
    title: 'Toggle Tool Notifications',
    description:
      'Enable or disable tool usage notifications for this group. When enabled, the bot will send a brief message to the group whenever it uses a tool (e.g. setting a reminder, checking weather).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        group_id: { type: 'string', description: 'The group ID to toggle notifications for' },
        enabled: { type: 'boolean', description: 'Whether to enable (true) or disable (false) tool notifications' },
      },
      required: ['group_id', 'enabled'],
    },
  },
  {
    name: 'get_tool_notification_status',
    title: 'Get Tool Notification Status',
    description: 'Check whether tool usage notifications are currently enabled or disabled for this group.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        group_id: { type: 'string', description: 'The group ID to check notification status for' },
      },
      required: ['group_id'],
    },
  },
];

let conn: DatabaseConnection;
let store: ToolNotificationStore;

export const settingsServer: McpServerDefinition = {
  serverName: 'signal-bot-settings',
  configKey: 'settings',
  entrypoint: 'settings',
  tools: TOOLS,
  envMapping: { DB_PATH: 'dbPath', MCP_GROUP_ID: 'groupId' },
  handlers: {
    toggle_tool_notifications(args) {
      const groupId = requireString(args, 'group_id');
      if (groupId.error) return groupId.error;

      return catchErrors(() => {
        const enabled = args.enabled === true || args.enabled === 'true';
        store.setEnabled(groupId.value, enabled);
        return ok(`Tool notifications ${enabled ? 'enabled' : 'disabled'} for this group.`);
      }, 'Failed to toggle tool notifications');
    },

    get_tool_notification_status(args) {
      const groupId = requireString(args, 'group_id');
      if (groupId.error) return groupId.error;

      return catchErrors(() => {
        const enabled = store.isEnabled(groupId.value);
        return ok(`Tool notifications are currently ${enabled ? 'enabled' : 'disabled'} for this group.`);
      }, 'Failed to get tool notification status');
    },
  },
  onInit() {
    const env = readStorageEnv();
    conn = new DatabaseConnection(env.dbPath);
    store = new ToolNotificationStore(conn);
    console.error(`Settings MCP server started (group: ${env.groupId || 'none'})`);
  },
  onClose() {
    conn.close();
  },
};

if (require.main === module) {
  runServer(settingsServer);
}
