import { ClaudeCLIClient } from './claudeClient';
import { Config } from './config';
import { logger } from './logger';
import { MessageHandler } from './messageHandler';
import { ReminderScheduler } from './reminderScheduler';
import { SignalClient } from './signalClient';
import { Storage } from './storage';

async function main() {
  logger.info('Starting Signal Family Bot...');

  const config = Config.load();
  logger.success('Configuration loaded');

  const storage = new Storage(config.dbPath);
  logger.success(`Database initialized at ${config.dbPath}`);

  const llmClient = new ClaudeCLIClient(config.claude.maxTurns);
  logger.success('Claude CLI client initialized');

  const signalClient = new SignalClient(config.signalCliUrl, config.botPhoneNumber);
  logger.success('Signal client initialized');

  const reminderScheduler = new ReminderScheduler(storage.reminders, signalClient);
  logger.success('Reminder scheduler initialized');

  const messageHandler = new MessageHandler(config.mentionTriggers, {
    messageContext: {
      groupId: '',
      sender: '',
      dbPath: config.dbPath,
      timezone: config.timezone,
      githubRepo: config.githubRepo,
      sourceRoot: config.sourceRoot,
      signalCliUrl: config.signalCliUrl,
      botPhoneNumber: config.botPhoneNumber,
      attachmentsDir: config.attachmentsDir,
      whisperModelPath: config.whisperModelPath,
    },
    systemPrompt: config.systemPrompt,
    storage,
    llmClient,
    signalClient,
    contextWindowSize: config.contextWindowSize,
    contextTokenBudget: config.contextTokenBudget,
    messageRetentionCount: config.messageRetentionCount,
  });
  logger.success(`Message handler initialized (triggers: ${config.mentionTriggers.join(', ')})`);

  if (config.testChannelOnly) {
    logger.warn(`*** TEST CHANNEL ONLY MODE — only processing group ${config.testGroupId} ***`);
  }

  // Graceful shutdown
  const shutdown = () => {
    logger.info('Shutting down gracefully...');
    storage.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Wait for signal-cli to be ready
  logger.info('Waiting for signal-cli...');
  await signalClient.waitForReady();

  // Start polling loop
  logger.success('Starting message polling...');
  const REMINDER_CHECK_MS = 30_000;
  let lastReminderCheck = 0;

  let pollCount = 0;
  let messagesSinceHeartbeat = 0;
  while (true) {
    try {
      pollCount++;
      const messages = await signalClient.receiveMessages();
      if (messages.length > 0) {
        logger.compact('POLL', `#${pollCount} received ${messages.length} message(s)`);
        messagesSinceHeartbeat += messages.length;
      } else if (pollCount % 30 === 0) {
        logger.debug(`POLL heartbeat: ${pollCount} polls, ${messagesSinceHeartbeat} messages since last heartbeat`);
        messagesSinceHeartbeat = 0;
      }

      for (const signalMsg of messages) {
        const data = signalClient.extractMessageData(signalMsg);

        if (!data) {
          logger.compact('SKIP', `(no data): ${JSON.stringify(signalMsg).substring(0, 200)}`);
          continue;
        }

        const storeOnly = config.testChannelOnly && data.groupId !== config.testGroupId;
        if (storeOnly) {
          logger.compact('STORED', `[${data.groupId}] ${data.sender}: ${data.content.substring(0, 80)}`);
        } else {
          logger.compact('RECV', `[${data.groupId}] ${data.sender}: ${data.content.substring(0, 80)}`);
        }
        await messageHandler.handleMessage(data.groupId, data.sender, data.content, data.timestamp, data.attachments, {
          storeOnly,
        });
      }

      // Check for due reminders periodically
      const now = Date.now();
      if (now - lastReminderCheck >= REMINDER_CHECK_MS) {
        lastReminderCheck = now;
        try {
          await reminderScheduler.processDueReminders();
        } catch (error) {
          logger.error('Error processing reminders:', error);
        }
      }
    } catch (error) {
      logger.error(`[poll #${pollCount}] Error in polling loop:`, error);
    }

    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}

main().catch(error => {
  logger.error('Fatal error:', error);
  process.exit(1);
});
