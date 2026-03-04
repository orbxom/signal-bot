export interface StorageEnv {
  dbPath: string;
  groupId: string;
  sender: string;
}

export function readStorageEnv(): StorageEnv {
  return {
    dbPath: process.env.DB_PATH || './data/bot.db',
    groupId: process.env.MCP_GROUP_ID || '',
    sender: process.env.MCP_SENDER || '',
  };
}

export function readTimezone(): string {
  return process.env.TZ || 'Australia/Sydney';
}
