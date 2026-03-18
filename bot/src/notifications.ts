import fs from 'node:fs';
import path from 'node:path';
import { logger } from './logger';

export interface NotifyConfig {
  startupNotify: boolean;
  testGroupId: string;
  timezone: string;
}

export async function sendStartupNotification(
  signalClient: { sendMessage(groupId: string, message: string): Promise<void> },
  config: NotifyConfig,
): Promise<void> {
  if (!config.startupNotify) return;

  try {
    let commitHash = 'unknown';
    try {
      commitHash = fs.readFileSync(path.resolve(__dirname, '../../VERSION'), 'utf-8').trim();
    } catch {
      // VERSION file missing — running in dev or .git not available
    }

    const now = new Date().toLocaleString('en-AU', {
      timeZone: config.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short',
    });

    await signalClient.sendMessage(config.testGroupId, `Bot online (${commitHash}) — ${now}`);
  } catch (error) {
    logger.error('Failed to send startup notification:', error);
  }
}

export async function sendErrorNotification(
  signalClient: { sendMessage(groupId: string, message: string): Promise<void> },
  config: NotifyConfig,
  error: unknown,
): Promise<void> {
  if (!config.startupNotify) return;

  try {
    const errorStr = error instanceof Error
      ? `${error.message}\n${error.stack ?? ''}`
      : String(error);

    const message = `Bot error — shutting down\n\n${errorStr}`.slice(0, 2000);
    await signalClient.sendMessage(config.testGroupId, message);
  } catch {
    // Best-effort — if signal-cli isn't available, just let it go
  }
}
