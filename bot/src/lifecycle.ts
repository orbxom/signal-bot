import type { SignalClient } from './signalClient';
import type { Storage } from './storage';

export function isQuietHours(timezone: string): boolean {
  const hour = Number.parseInt(
    new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: timezone }).format(new Date()),
    10,
  );
  return hour >= 21 || hour < 6;
}

export async function broadcastToAllGroups(
  signalClient: SignalClient,
  storage: Storage,
  timezone: string,
  message: string,
): Promise<void> {
  if (isQuietHours(timezone)) {
    console.log('Quiet hours (9pm-6am), skipping notification');
    return;
  }

  const groupIds = storage.getDistinctGroupIds();
  if (groupIds.length === 0) {
    console.log('No known groups to notify');
    return;
  }

  console.log(`Sending notification to ${groupIds.length} group(s)...`);
  const results = await Promise.allSettled(groupIds.map(groupId => signalClient.sendMessage(groupId, message)));

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'rejected') {
      console.error(`Failed to notify group ${groupIds[i]}:`, result.reason);
    }
  }
}
