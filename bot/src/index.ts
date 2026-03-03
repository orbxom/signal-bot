import { ClaudeCLIClient } from './claudeClient';
import { Config } from './config';
import { MessageHandler } from './messageHandler';
import { ReminderScheduler } from './reminderScheduler';
import { SignalClient } from './signalClient';
import { Storage } from './storage';

export function isQuietHours(timezone: string): boolean {
  const hour = Number.parseInt(
    new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: timezone }).format(new Date()),
    10,
  );
  return hour >= 21 || hour < 6;
}

async function broadcastToAllGroups(
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

async function main() {
  console.log('Starting Signal Family Bot...');

  const config = Config.load();
  console.log('Configuration loaded');

  const storage = new Storage(config.dbPath);
  console.log(`Database initialized at ${config.dbPath}`);

  const llmClient = new ClaudeCLIClient(config.claude.maxTurns);
  console.log('Claude CLI client initialized');

  const signalClient = new SignalClient(config.signalCliUrl, config.botPhoneNumber);
  console.log('Signal client initialized');

  const reminderScheduler = new ReminderScheduler(storage, signalClient);
  console.log('Reminder scheduler initialized');

  const messageHandler = new MessageHandler(config.mentionTriggers, {
    botPhoneNumber: config.botPhoneNumber,
    systemPrompt: config.systemPrompt,
    storage,
    llmClient,
    signalClient,
    contextWindowSize: config.contextWindowSize,
    timezone: config.timezone,
    dbPath: config.dbPath,
    githubRepo: config.githubRepo,
    sourceRoot: config.sourceRoot,
  });
  console.log(`Message handler initialized (triggers: ${config.mentionTriggers.join(', ')})`);

  if (config.testChannelOnly) {
    console.log(`*** TEST CHANNEL ONLY MODE — only processing group ${config.testGroupId} ***`);
  }

  // Graceful shutdown
  let shuttingDown = false;

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log('\nShutting down gracefully...');

    try {
      if (config.testChannelOnly) {
        await signalClient.sendMessage(config.testGroupId, 'Im off to take a nap');
      } else {
        await broadcastToAllGroups(signalClient, storage, config.timezone, 'Im off to take a nap');
      }
    } catch (error) {
      console.error('Error sending shutdown notification:', error);
    }

    storage.close();
    process.exit(0);
  };

  process.on('SIGINT', () => {
    shutdown();
  });
  process.on('SIGTERM', () => {
    shutdown();
  });

  // Wait for signal-cli to be ready
  console.log('Waiting for signal-cli...');
  await signalClient.waitForReady();

  // Notify groups that the bot is online
  if (config.testChannelOnly) {
    await signalClient.sendMessage(config.testGroupId, "I'm finished with my nap! (test channel only mode)");
  } else {
    await broadcastToAllGroups(signalClient, storage, config.timezone, "I'm finished with my nap!");
  }

  // Start polling loop
  console.log('Starting message polling...');
  const REMINDER_CHECK_MS = 30_000;
  let lastReminderCheck = 0;

  while (true) {
    try {
      const messages = await signalClient.receiveMessages();

      for (const signalMsg of messages) {
        const data = signalClient.extractMessageData(signalMsg);

        if (data) {
          if (config.testChannelOnly && data.groupId !== config.testGroupId) {
            continue;
          }
          console.log(`[${data.groupId}] ${data.sender}: ${data.content.substring(0, 50)}...`);
          await messageHandler.handleMessage(data.groupId, data.sender, data.content, data.timestamp);
        }
      }

      // Check for due reminders periodically
      const now = Date.now();
      if (now - lastReminderCheck >= REMINDER_CHECK_MS) {
        lastReminderCheck = now;
        try {
          await reminderScheduler.processDueReminders();
        } catch (error) {
          console.error('Error processing reminders:', error);
        }
      }
    } catch (error) {
      console.error('Error in polling loop:', error);
    }

    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
