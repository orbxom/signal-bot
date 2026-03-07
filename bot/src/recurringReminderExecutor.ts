import { parseClaudeOutput, spawnPromise } from './claudeClient';
import { logger } from './logger';
import { buildAllowedTools, buildMcpConfig } from './mcp/registry';
import type { SignalClient } from './signalClient';
import type { AppConfig, RecurringReminder } from './types';

export class RecurringReminderExecutor {
  constructor(
    private appConfig: AppConfig,
    private signalClient: SignalClient,
    private maxTurns: number,
  ) {}

  async execute(reminder: RecurringReminder): Promise<void> {
    const context = {
      ...this.appConfig,
      groupId: reminder.groupId,
      sender: reminder.requester,
    };

    const systemPrompt = [
      'You are a helpful assistant in a Signal group chat. A recurring reminder has fired.',
      'Process the following instruction and send your response to the group using the send_message tool.',
      `Current time: ${new Date().toISOString()}`,
      `Timezone: ${reminder.timezone}`,
      `Group ID: ${reminder.groupId}`,
    ].join('\n');

    const mcpConfig = buildMcpConfig(context);
    const agentsConfig = JSON.stringify({
      'message-historian': {
        description: 'Searches and summarizes historical messages from this group chat.',
        prompt: `You search through chat history and return concise summaries. Use search_messages for keyword lookups and get_messages_by_date for date ranges. Timezone: ${reminder.timezone}`,
        tools: ['mcp__history__search_messages', 'mcp__history__get_messages_by_date'],
        model: 'haiku',
      },
    });

    const args = [
      '-p',
      reminder.promptText,
      '--output-format',
      'json',
      '--max-turns',
      String(this.maxTurns),
      '--no-session-persistence',
      '--allowedTools',
      buildAllowedTools(),
      '--mcp-config',
      JSON.stringify(mcpConfig),
      '--strict-mcp-config',
      '--system-prompt',
      systemPrompt,
      '--agents',
      agentsConfig,
    ];

    logger.step(`recurring: executing reminder #${reminder.id}: "${reminder.promptText.substring(0, 60)}"`);

    const { stdout } = await spawnPromise('claude', args, {
      timeout: 300000,
      env: { ...process.env, CLAUDECODE: '' },
    });

    const response = parseClaudeOutput(stdout);

    if (!response.sentViaMcp) {
      await this.signalClient.sendMessage(reminder.groupId, response.content);
    }

    logger.step(`recurring: reminder #${reminder.id} completed (${response.sentViaMcp ? 'via MCP' : 'direct send'})`);
  }
}
