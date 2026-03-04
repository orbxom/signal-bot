import { error, getErrorMessage, ok } from '../result';
import { runServer } from '../runServer';
import type { McpServerDefinition } from '../types';

const BOM_BASE_URL = 'https://api.weather.bom.gov.au/v1';

const TOOLS = [
  {
    name: 'search_location',
    title: 'Search Location',
    description:
      'Search for an Australian location by name, postcode, or coordinates to get its geohash. You MUST call this first to get a geohash before using other weather tools.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description:
            'Location name (e.g. "Sydney"), postcode (e.g. "2000"), or coordinates (e.g. "-33.87,151.21"). Minimum 3 characters.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_observations',
    title: 'Get Current Observations',
    description:
      'Get current weather observations for a location. Returns temperature, feels-like, wind, humidity, and rain since 9am from the nearest weather station.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        geohash: {
          type: 'string',
          description: 'Location geohash from search_location (6 or 7 characters)',
        },
      },
      required: ['geohash'],
    },
  },
  {
    name: 'get_forecast',
    title: 'Get Daily Forecast',
    description:
      'Get the 7-day daily forecast for a location. Returns date, min/max temps, rain chance, rain amount, UV, and text summary for each day.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        geohash: {
          type: 'string',
          description: 'Location geohash from search_location (6 or 7 characters)',
        },
      },
      required: ['geohash'],
    },
  },
  {
    name: 'get_warnings',
    title: 'Get Weather Warnings',
    description:
      'Get active weather warnings for a location. Returns warning type, title, issue time, and expiry time.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        geohash: {
          type: 'string',
          description: 'Location geohash from search_location (6 or 7 characters)',
        },
      },
      required: ['geohash'],
    },
  },
];

async function bomFetch(path: string): Promise<unknown> {
  const url = `${BOM_BASE_URL}${path}`;
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`BOM API error (${response.status}): ${body}`);
  }
  return response.json();
}

function trimGeohash(geohash: string): string {
  return geohash.substring(0, 6);
}

export const weatherServer: McpServerDefinition = {
  serverName: 'signal-bot-weather',
  configKey: 'weather',
  entrypoint: 'mcp/servers/weather',
  tools: TOOLS,
  envMapping: { TZ: 'timezone' },
  handlers: {
    async search_location(args) {
      const query = args.query as string;
      if (!query || typeof query !== 'string') {
        return error('Missing or invalid query parameter.');
      }
      if (query.length < 3) {
        return error('Query must be at least 3 characters.');
      }

      try {
        const result = (await bomFetch(`/locations?search=${encodeURIComponent(query)}`)) as {
          data: Array<{ geohash: string; name: string; state: string; postcode: string | null }>;
        };

        if (!result.data || result.data.length === 0) {
          return ok(`No locations found for "${query}".`);
        }

        const lines = result.data.slice(0, 10).map(loc => {
          const parts = [loc.name];
          if (loc.state) parts.push(loc.state);
          if (loc.postcode) parts.push(loc.postcode);
          return `${parts.join(', ')} — geohash: ${loc.geohash}`;
        });

        return ok(`Locations found:\n${lines.join('\n')}`);
      } catch (err) {
        return error(`Weather API error: ${getErrorMessage(err)}`);
      }
    },

    async get_observations(args) {
      const geohash = args.geohash as string;
      if (!geohash || typeof geohash !== 'string' || geohash.length < 6) {
        return error('Missing or invalid geohash (need at least 6 characters).');
      }

      try {
        const geo6 = trimGeohash(geohash);
        const result = (await bomFetch(`/locations/${geo6}/observations`)) as {
          data: {
            temp: number | null;
            temp_feels_like: number | null;
            wind: { speed_kilometre: number | null; direction: string | null } | null;
            gust: { speed_kilometre: number | null } | null;
            max_temp: { value: number | null; time: string | null } | null;
            min_temp: { value: number | null; time: string | null } | null;
            rain_since_9am: number | null;
            humidity: number | null;
            station: { name: string | null; distance: number | null } | null;
          };
        };

        const d = result.data;
        const lines: string[] = [];

        if (d.station?.name) {
          const dist = d.station.distance != null ? ` (${Math.round(d.station.distance)}m away)` : '';
          lines.push(`Station: ${d.station.name}${dist}`);
        }
        if (d.temp != null)
          lines.push(
            `Temperature: ${d.temp}°C${d.temp_feels_like != null ? ` (feels like ${d.temp_feels_like}°C)` : ''}`,
          );
        if (d.humidity != null) lines.push(`Humidity: ${d.humidity}%`);
        if (d.wind) {
          const dir = d.wind.direction || '?';
          const speed = d.wind.speed_kilometre ?? '?';
          const gust = d.gust?.speed_kilometre != null ? `, gusting ${d.gust.speed_kilometre} km/h` : '';
          lines.push(`Wind: ${dir} ${speed} km/h${gust}`);
        }
        if (d.rain_since_9am != null) lines.push(`Rain since 9am: ${d.rain_since_9am}mm`);
        if (d.max_temp?.value != null && d.min_temp?.value != null) {
          lines.push(`Today's range: ${d.min_temp.value}°C – ${d.max_temp.value}°C`);
        }

        if (lines.length === 0) {
          return ok('No observation data available for this location.');
        }

        return ok(`Current observations:\n${lines.join('\n')}`);
      } catch (err) {
        return error(`Weather API error: ${getErrorMessage(err)}`);
      }
    },

    async get_forecast(args) {
      const geohash = args.geohash as string;
      if (!geohash || typeof geohash !== 'string' || geohash.length < 6) {
        return error('Missing or invalid geohash (need at least 6 characters).');
      }

      try {
        const result = (await bomFetch(`/locations/${geohash}/forecasts/daily`)) as {
          data: Array<{
            date: string;
            temp_max: number | null;
            temp_min: number | null;
            short_text: string | null;
            extended_text: string | null;
            rain: { chance: number | null; amount: { min: number | null; max: number | null } | null } | null;
            uv: { category: string | null; max_index: number | null } | null;
            fire_danger: string | null;
          }>;
        };

        if (!result.data || result.data.length === 0) {
          return ok('No forecast data available for this location.');
        }

        const tz = process.env.TZ || 'Australia/Sydney';
        const lines = result.data.map(day => {
          const date = new Date(day.date);
          const dateStr = date.toLocaleDateString('en-AU', {
            weekday: 'short',
            day: 'numeric',
            month: 'short',
            timeZone: tz,
          });

          const parts: string[] = [`${dateStr}:`];

          if (day.temp_min != null && day.temp_max != null) {
            parts.push(`${day.temp_min}–${day.temp_max}°C`);
          } else if (day.temp_max != null) {
            parts.push(`Max ${day.temp_max}°C`);
          }

          if (day.short_text) parts.push(`| ${day.short_text}`);

          if (day.rain?.chance != null) {
            let rainStr = `| Rain: ${day.rain.chance}%`;
            if (day.rain.amount?.min != null && day.rain.amount?.max != null) {
              rainStr += ` (${day.rain.amount.min}–${day.rain.amount.max}mm)`;
            }
            parts.push(rainStr);
          }

          if (day.uv?.max_index != null) {
            const cat = day.uv.category ? ` ${day.uv.category}` : '';
            parts.push(`| UV:${cat} (${day.uv.max_index})`);
          }

          if (day.fire_danger) parts.push(`| Fire: ${day.fire_danger}`);

          return parts.join(' ');
        });

        return ok(`7-day forecast:\n${lines.join('\n')}`);
      } catch (err) {
        return error(`Weather API error: ${getErrorMessage(err)}`);
      }
    },

    async get_warnings(args) {
      const geohash = args.geohash as string;
      if (!geohash || typeof geohash !== 'string' || geohash.length < 6) {
        return error('Missing or invalid geohash (need at least 6 characters).');
      }

      try {
        const result = (await bomFetch(`/locations/${geohash}/warnings`)) as {
          data: Array<{
            id: string;
            type: string;
            title: string;
            short_title: string | null;
            state: string | null;
            warning_group_type: string | null;
            issue_time: string | null;
            expiry_time: string | null;
            phase: string | null;
          }>;
        };

        if (!result.data || result.data.length === 0) {
          return ok('No active weather warnings for this location.');
        }

        const tz = process.env.TZ || 'Australia/Sydney';
        const lines = result.data.map(w => {
          const parts: string[] = [`- ${w.title || w.short_title || w.type}`];
          if (w.warning_group_type) parts.push(`(${w.warning_group_type})`);
          if (w.phase) parts.push(`[${w.phase}]`);
          if (w.expiry_time) {
            const expiry = new Date(w.expiry_time).toLocaleString('en-AU', { timeZone: tz });
            parts.push(`— expires ${expiry}`);
          }
          return parts.join(' ');
        });

        return ok(`Active warnings:\n${lines.join('\n')}`);
      } catch (err) {
        return error(`Weather API error: ${getErrorMessage(err)}`);
      }
    },
  },
  onInit() {
    console.error('Weather MCP server started');
  },
};

if (require.main === module) {
  runServer(weatherServer);
}
