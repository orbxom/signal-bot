import { catchErrors, error, ok } from '../result';
import { runServer } from '../runServer';
import type { McpServerDefinition, ToolDefinition } from '../types';
import { optionalString } from '../validate';

/** Curated list of notable dates, keyed by MM-DD. Includes Australian fixed-date holidays and major international observances. */
const NOTABLE_DATES: Record<string, Array<{ name: string; description: string }>> = {
  '01-01': [{ name: "New Year's Day", description: 'The first day of the year in the Gregorian calendar.' }],
  '01-26': [{ name: 'Australia Day', description: 'Australian national day marking the arrival of the First Fleet in 1788.' }],
  '01-27': [{ name: 'International Holocaust Remembrance Day', description: 'UN-designated day honouring Holocaust victims.' }],
  '02-14': [{ name: "Valentine's Day", description: 'Day celebrating love and affection.' }],
  '03-08': [{ name: "International Women's Day", description: "Celebrates women's achievements and advocates for gender equality." }],
  '03-20': [{ name: 'International Day of Happiness', description: "UN-designated day recognising the importance of happiness in people's lives." }],
  '03-21': [{ name: 'Harmony Day', description: 'Australian day celebrating cultural diversity and inclusiveness.' }],
  '03-22': [{ name: 'World Water Day', description: 'UN-designated day highlighting the importance of freshwater.' }],
  '04-07': [{ name: 'World Health Day', description: 'Marks the founding of the WHO and raises health awareness.' }],
  '04-22': [{ name: 'Earth Day', description: 'Annual event demonstrating support for environmental protection.' }],
  '04-25': [{ name: 'ANZAC Day', description: 'Day of remembrance for Australian and New Zealand forces who served in wars and conflicts.' }],
  '05-01': [{ name: "International Workers' Day", description: 'Celebrates labourers and the working class.' }],
  '05-26': [{ name: 'National Sorry Day', description: 'Australian day acknowledging the mistreatment of Aboriginal and Torres Strait Islander peoples.' }],
  '06-03': [{ name: 'Mabo Day', description: 'Commemorates the High Court Mabo decision recognising native title in Australia.' }],
  '06-05': [{ name: 'World Environment Day', description: 'UN-designated day encouraging awareness and action for environmental protection.' }],
  '06-20': [{ name: 'World Refugee Day', description: 'UN-designated day honouring refugees and displaced people worldwide.' }],
  '08-09': [{ name: "International Day of the World's Indigenous Peoples", description: "UN-designated day recognising indigenous peoples' rights and contributions." }],
  '08-12': [{ name: 'International Youth Day', description: 'UN-designated day raising awareness of youth issues.' }],
  '09-21': [{ name: 'International Day of Peace', description: 'UN-designated day devoted to strengthening the ideals of peace.' }],
  '10-16': [{ name: 'World Food Day', description: 'Marks the founding of the FAO and promotes food security.' }],
  '10-31': [{ name: 'Halloween', description: "Traditional celebration on the eve of All Saints' Day." }],
  '11-11': [{ name: 'Remembrance Day', description: 'Day to remember those who served and died in armed conflicts.' }],
  '12-01': [{ name: 'World AIDS Day', description: 'International day dedicated to raising awareness of HIV/AIDS.' }],
  '12-10': [{ name: 'Human Rights Day', description: 'Commemorates the adoption of the Universal Declaration of Human Rights.' }],
  '12-25': [{ name: 'Christmas Day', description: 'Annual festival commemorating the birth of Jesus Christ, widely celebrated as a cultural holiday.' }],
  '12-26': [{ name: 'Boxing Day', description: 'Australian public holiday the day after Christmas.' }],
  '12-31': [{ name: "New Year's Eve", description: 'The last day of the year, celebrated with gatherings and festivities.' }],
};

function getCuratedDatesForDate(month: number, day: number): Array<{ name: string; description: string }> {
  const key = `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return NOTABLE_DATES[key] ?? [];
}

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
