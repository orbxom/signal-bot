import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readTimezone } from '../env';
import { catchErrors, error, ok } from '../result';
import { runServer } from '../runServer';
import type { McpServerDefinition } from '../types';
import { optionalString, requireString, type StringResult } from '../validate';

const BOM_BASE_URL = 'https://api.weather.bom.gov.au/v1';
const BOM_RADAR_BASE = 'https://reg.bom.gov.au/radar';

// Hardcoded BOM radar station data. BOM has no discovery API;
// adding new stations requires a code change.
const RADAR_STATION_LIST = [
  { code: '71', name: 'Sydney (Terrey Hills)', aliases: ['sydney', 'terrey hills'] },
  { code: '02', name: 'Melbourne', aliases: ['melbourne'] },
  { code: '66', name: 'Brisbane (Mt Stapylton)', aliases: ['brisbane', 'mt stapylton'] },
  { code: '64', name: 'Adelaide (Buckland Park)', aliases: ['adelaide', 'buckland park'] },
  { code: '70', name: 'Perth (Serpentine)', aliases: ['perth', 'serpentine'] },
  { code: '37', name: 'Hobart', aliases: ['hobart'] },
  { code: '63', name: 'Darwin (Berrimah)', aliases: ['darwin', 'berrimah'] },
  { code: '40', name: 'Canberra (Captains Flat)', aliases: ['canberra', 'captains flat'] },
  { code: '04', name: 'Newcastle (Lemon Tree Passage)', aliases: ['newcastle', 'lemon tree passage'] },
  { code: '19', name: 'Cairns', aliases: ['cairns'] },
  { code: '73', name: 'Townsville (Hervey Range)', aliases: ['townsville', 'hervey range'] },
  { code: '28', name: 'Gold Coast (Mt Tamborine)', aliases: ['gold coast', 'mt tamborine'] },
  { code: '03', name: 'Wollongong (Appin)', aliases: ['wollongong', 'appin'] },
  { code: '25', name: 'Alice Springs', aliases: ['alice springs'] },
  { code: '23', name: 'Gladstone', aliases: ['gladstone'] },
  { code: '22', name: 'Mackay', aliases: ['mackay'] },
  { code: '72', name: 'Rockhampton', aliases: ['rockhampton'] },
] as const;

const RADAR_STATIONS: Record<string, { code: string; name: string }> = Object.fromEntries(
  RADAR_STATION_LIST.flatMap(s => s.aliases.map(a => [a, s])),
);

const RANGE_MAP: Record<string, string> = {
  '512km': '1',
  '256km': '2',
  '128km': '3',
  '64km': '4',
};

const AVAILABLE_STATIONS = RADAR_STATION_LIST.map(s => s.name)
  .sort()
  .join(', ');

function cleanupOldRadarFiles(): void {
  const tmpDir = os.tmpdir();
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  try {
    for (const file of fs.readdirSync(tmpDir)) {
      if (file.startsWith('radar-IDR') && file.endsWith('.gif')) {
        const filePath = path.join(tmpDir, file);
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < oneHourAgo) {
          fs.unlinkSync(filePath);
        }
      }
    }
  } catch {
    // Best-effort cleanup; ignore errors
  }
}

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
  {
    name: 'get_radar_image',
    title: 'Get BOM Radar Image',
    description:
      'Fetch the current BOM weather radar image for an Australian location. Returns a file path to a GIF image that can be sent using send_image. Use this when someone asks for a radar image or weather radar.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        location: {
          type: 'string',
          description:
            'Location name (e.g. "Sydney", "Melbourne", "Brisbane"). Use list of available stations in error message if unsure.',
        },
        range: {
          type: 'string',
          description: 'Radar range: "64km", "128km", "256km", or "512km". Defaults to "128km".',
          enum: ['64km', '128km', '256km', '512km'],
        },
      },
      required: ['location'],
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

function requireGeohash(args: Record<string, unknown>): StringResult {
  const geohash = requireString(args, 'geohash');
  if (geohash.error) return geohash;
  if (geohash.value.length < 6) {
    return { error: error('Missing or invalid geohash (need at least 6 characters).') };
  }
  return geohash;
}

export const weatherServer: McpServerDefinition = {
  serverName: 'signal-bot-weather',
  configKey: 'weather',
  entrypoint: 'weather',
  tools: TOOLS,
  envMapping: { TZ: 'timezone' },
  handlers: {
    async search_location(args) {
      const query = requireString(args, 'query');
      if (query.error) return query.error;
      if (query.value.length < 3) {
        return error('Query must be at least 3 characters.');
      }

      return catchErrors(async () => {
        const result = (await bomFetch(`/locations?search=${encodeURIComponent(query.value)}`)) as {
          data: Array<{ geohash: string; name: string; state: string; postcode: string | null }>;
        };

        if (!result.data || result.data.length === 0) {
          return ok(`No locations found for "${query.value}".`);
        }

        const lines = result.data.slice(0, 10).map(loc => {
          const parts = [loc.name];
          if (loc.state) parts.push(loc.state);
          if (loc.postcode) parts.push(loc.postcode);
          return `${parts.join(', ')} — geohash: ${loc.geohash}`;
        });

        return ok(`Locations found:\n${lines.join('\n')}`);
      }, 'Weather API error');
    },

    async get_observations(args) {
      const geohash = requireGeohash(args);
      if (geohash.error) return geohash.error;

      return catchErrors(async () => {
        const geo6 = trimGeohash(geohash.value);
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
      }, 'Weather API error');
    },

    async get_forecast(args) {
      const geohash = requireGeohash(args);
      if (geohash.error) return geohash.error;

      return catchErrors(async () => {
        const result = (await bomFetch(`/locations/${geohash.value}/forecasts/daily`)) as {
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

        const tz = readTimezone();
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
      }, 'Weather API error');
    },

    async get_warnings(args) {
      const geohash = requireGeohash(args);
      if (geohash.error) return geohash.error;

      return catchErrors(async () => {
        const result = (await bomFetch(`/locations/${geohash.value}/warnings`)) as {
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

        const tz = readTimezone();
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
      }, 'Weather API error');
    },
    async get_radar_image(args) {
      const location = requireString(args, 'location');
      if (location.error) return location.error;

      const key = location.value.toLowerCase();
      const station = RADAR_STATIONS[key];
      if (!station) {
        return error(`Unknown location "${location.value}". Available stations: ${AVAILABLE_STATIONS}`);
      }

      const range = optionalString(args, 'range', '128km');
      const suffix = RANGE_MAP[range];
      if (!suffix) {
        return error(`Invalid range "${range}". Valid ranges: ${Object.keys(RANGE_MAP).join(', ')}`);
      }

      return catchErrors(async () => {
        const productId = `IDR${station.code}${suffix}`;
        const url = `${BOM_RADAR_BASE}/${productId}.gif`;
        const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
        if (!response.ok) {
          throw new Error(`BOM radar error (${response.status}): radar image not available for ${station.name}`);
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        const magic = buffer.subarray(0, 6).toString('ascii');
        if (magic !== 'GIF89a' && magic !== 'GIF87a') {
          throw new Error(`BOM returned invalid data for ${station.name} radar (expected GIF image)`);
        }

        cleanupOldRadarFiles();

        const filePath = path.join(os.tmpdir(), `radar-${productId}-${Date.now()}.gif`);
        await fs.promises.writeFile(filePath, buffer);

        return ok(`Radar image saved: ${filePath}\nStation: ${station.name} (${range} range)`);
      }, 'Radar fetch error');
    },
  },
  onInit() {
    console.error('Weather MCP server started');
  },
};

if (require.main === module) {
  runServer(weatherServer);
}
