import { ClaudeCLIClient, spawnLimiter } from './claudeClient';
import { Config } from './config';
import { logger } from './logger';
import { MessageHandler } from './messageHandler';
import { sendStartupNotification, sendErrorNotification } from './notifications';
import { PollingBackoff } from './pollingBackoff';
import { RecurringReminderExecutor } from './recurringReminderExecutor';
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

  const appConfig = {
    dbPath: config.dbPath,
    timezone: config.timezone,
    githubRepo: config.githubRepo,
    sourceRoot: config.sourceRoot,
    signalCliUrl: config.signalCliUrl,
    botPhoneNumber: config.botPhoneNumber,
    attachmentsDir: config.attachmentsDir,
    whisperModelPath: config.whisperModelPath,
    darkFactoryEnabled: config.darkFactoryEnabled,
    darkFactoryProjectRoot: config.darkFactoryProjectRoot,
  };

  const recurringExecutor = new RecurringReminderExecutor(appConfig, signalClient, config.claude.maxTurns, groupId =>
    storage.groupSettings.getToolNotifications(groupId),
  );
  logger.success('Recurring reminder executor initialized');

  const reminderScheduler = new ReminderScheduler(
    storage.reminders,
    signalClient,
    storage.recurringReminders,
    recurringExecutor,
  );
  logger.success('Reminder scheduler initialized');

  const messageHandler = new MessageHandler(
    config.mentionTriggers,
    {
      storage,
      llmClient,
      signalClient,
      appConfig,
    },
    {
      systemPrompt: config.systemPrompt,
      contextWindowSize: config.contextWindowSize,
      contextTokenBudget: config.contextTokenBudget,
      messageRetentionCount: config.messageRetentionCount,
      attachmentRetentionDays: config.attachmentRetentionDays,
      collaborativeTestingMode: config.collaborativeTestingMode,
    },
  );
  logger.success(`Message handler initialized (triggers: ${config.mentionTriggers.join(', ')})`);

  if (config.testChannelOnly) {
    logger.warn(`*** TEST CHANNEL ONLY MODE — only processing group ${config.testGroupId} ***`);
  }
  if (config.excludeGroupIds.length > 0) {
    logger.warn(`*** EXCLUDING ${config.excludeGroupIds.length} group(s) from LLM processing ***`);
  }

  // Graceful shutdown
  const shutdown = () => {
    logger.info('Shutting down gracefully...');
    spawnLimiter.killAll();
    logger.close();
    storage.close();
    setTimeout(() => process.exit(0), 2000);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection:', reason);
    sendErrorNotification(signalClient, config, reason).finally(() => {
      process.exit(1);
    });
  });

  // Wait for signal-cli to be ready
  logger.info('Waiting for signal-cli...');
  await signalClient.waitForReady();

  await sendStartupNotification(signalClient, config);

  // Start polling loop
  logger.success('Starting message polling...');
  const REMINDER_CHECK_MS = 30_000;
  const CHECKPOINT_MS = 5 * 60 * 1000; // 5 minutes
  let lastReminderCheck = 0;
  let lastCheckpoint = 0;
  const backoff = new PollingBackoff();

  let pollCount = 0;
  let messagesSinceHeartbeat = 0;
  while (true) {
    try {
      pollCount++;
      const messages = await signalClient.receiveMessages();
      backoff.recordSuccess();
      if (messages.length > 0) {
        logger.compact('POLL', `#${pollCount} received ${messages.length} message(s)`);
        messagesSinceHeartbeat += messages.length;
      } else if (pollCount % 30 === 0) {
        logger.debug(`POLL heartbeat: ${pollCount} polls, ${messagesSinceHeartbeat} messages since last heartbeat`);
        messagesSinceHeartbeat = 0;
      }

      // Extract and group messages by groupId
      const byGroup = new Map<string, import('./types').ExtractedMessage[]>();
      for (const signalMsg of messages) {
        const data = signalClient.extractMessageData(signalMsg);
        if (!data) {
          logger.compact('SKIP', `(no data): ${JSON.stringify(signalMsg).substring(0, 200)}`);
          continue;
        }

        const storeOnly =
          (config.testChannelOnly && data.groupId !== config.testGroupId) ||
          config.excludeGroupIds.includes(data.groupId);
        if (storeOnly) {
          logger.compact('STORED', `[${data.groupId}] ${data.sender}: ${data.content.substring(0, 80)}`);
        } else {
          logger.compact('RECV', `[${data.groupId}] ${data.sender}: ${data.content.substring(0, 80)}`);
        }

        if (!byGroup.has(data.groupId)) {
          byGroup.set(data.groupId, []);
        }
        byGroup.get(data.groupId)?.push(data);
      }

      // Process each group's messages as a batch
      for (const [groupId, batch] of byGroup) {
        try {
          const storeOnly =
            (config.testChannelOnly && groupId !== config.testGroupId) || config.excludeGroupIds.includes(groupId);
          await messageHandler.handleMessageBatch(groupId, batch, { storeOnly });
        } catch (error) {
          logger.error(`Error processing group ${groupId}:`, error);
        }
      }

      // Check for due reminders and run maintenance periodically
      const now = Date.now();
      if (now - lastReminderCheck >= REMINDER_CHECK_MS) {
        lastReminderCheck = now;
        try {
          await reminderScheduler.processDueReminders();
          messageHandler.runMaintenance();
        } catch (error) {
          logger.error('Error processing reminders:', error);
        }
      }

      // Checkpoint less frequently
      if (now - lastCheckpoint >= CHECKPOINT_MS) {
        lastCheckpoint = now;
        try {
          storage.checkpoint();
        } catch (error) {
          logger.error('WAL checkpoint failed:', error);
        }
      }
    } catch (error) {
      logger.error(`[poll #${pollCount}] Error in polling loop:`, error);
      backoff.recordError();
      if (backoff.shouldReconnect()) {
        try {
          logger.info('Attempting signal-cli reconnection...');
          await signalClient.waitForReady();
          logger.success('signal-cli reconnected');
        } catch (reconnectError) {
          logger.error('signal-cli reconnection failed:', reconnectError);
        }
      }
    }

    await new Promise(resolve => setTimeout(resolve, backoff.getDelay()));
  }
}

main().catch(async (error) => {
  logger.error('Fatal error:', error);
  // Best-effort: signalClient may not be initialized if error was during startup
  // This catch can't access signalClient from main's scope, so create a temporary one
  try {
    const config = Config.load();
    if (config.startupNotify) {
      const tempClient = new SignalClient(config.signalCliUrl, config.botPhoneNumber);
      await Promise.race([
        sendErrorNotification(tempClient, config, error),
        new Promise(resolve => setTimeout(resolve, 5000)),
      ]);
    }
  } catch {
    // Config or signal-cli not available — just exit
  }
  process.exit(1);
});
