import { catchErrors, error, ok } from '../result';
import { runServer } from '../runServer';
import type { McpServerDefinition, ToolDefinition } from '../types';
import { optionalString } from '../validate';

const TOOLS: ToolDefinition[] = [
  {
    name: 'get_notable_dates',
    title: 'Get Notable Dates',
    description:
      'Get notable holidays and observances for a given date. Returns Australian public holidays and major international observances. Accepts an optional date in YYYY-MM-DD format; defaults to today.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        date: {
          type: 'string',
          description:
            'Date in YYYY-MM-DD format (e.g., "2026-03-08"). Defaults to today if omitted.',
        },
      },
    },
  },
];

export const notableDatesServer: McpServerDefinition = {
  serverName: 'signal-bot-notable-dates',
  configKey: 'notableDates',
  entrypoint: 'notableDates',
  tools: TOOLS,
  envMapping: { TZ: 'timezone' },
  handlers: {
    get_notable_dates(args) {
      return error('Not implemented yet');
    },
  },
  onInit() {
    console.error('Notable Dates MCP server started');
  },
};

if (require.main === module) {
  runServer(notableDatesServer);
}
