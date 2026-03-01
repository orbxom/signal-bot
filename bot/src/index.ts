import { ClaudeCLIClient } from './claudeClient';
import { Config } from './config';
import { MessageHandler } from './messageHandler';
import { SignalClient } from './signalClient';
import { Storage } from './storage';

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

  const messageHandler = new MessageHandler(config.mentionTriggers, {
    botPhoneNumber: config.botPhoneNumber,
    systemPrompt: config.systemPrompt,
    storage,
    llmClient,
    signalClient,
    contextWindowSize: config.contextWindowSize,
  });
  console.log(`Message handler initialized (triggers: ${config.mentionTriggers.join(', ')})`);

  // Graceful shutdown
  const shutdown = () => {
    console.log('\nShutting down gracefully...');
    storage.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Wait for signal-cli to be ready
  console.log('Waiting for signal-cli...');
  await signalClient.waitForReady();

  // Start polling loop
  console.log('Starting message polling...');
  while (true) {
    try {
      const messages = await signalClient.receiveMessages();

      for (const signalMsg of messages) {
        const data = signalClient.extractMessageData(signalMsg);

        if (data) {
          console.log(`[${data.groupId}] ${data.sender}: ${data.content.substring(0, 50)}...`);
          await messageHandler.handleMessage(data.groupId, data.sender, data.content, data.timestamp);
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
