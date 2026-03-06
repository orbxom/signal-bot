/**
 * Shared timestamp formatting utility.
 * Accepts a timestamp and an Intl.DateTimeFormat instance,
 * returns a "YYYY-MM-DD HH:MM" string.
 */
export function formatTimestamp(timestamp: number, formatter: Intl.DateTimeFormat): string {
  const parts = formatter.formatToParts(new Date(timestamp));
  const get = (type: string) => parts.find(p => p.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}
