import { error } from './result';
import type { ToolResult } from './types';

type StringResult = { value: string; error?: undefined } | { value?: undefined; error: ToolResult };
type NumberResult = { value: number; error?: undefined } | { value?: undefined; error: ToolResult };

export function requireString(args: Record<string, unknown>, name: string): StringResult {
  const val = args[name];
  if (val === undefined || val === null || typeof val !== 'string' || val === '') {
    return { error: error(`Missing or invalid ${name} parameter.`) };
  }
  return { value: val };
}

export function requireNumber(args: Record<string, unknown>, name: string): NumberResult {
  const val = args[name];
  if (val === undefined || val === null || typeof val !== 'number') {
    return { error: error(`Missing or invalid ${name} parameter.`) };
  }
  return { value: val };
}

export function requireGroupId(groupId: string): ToolResult | null {
  if (!groupId) {
    return error('No group context available.');
  }
  return null;
}

export function optionalString(args: Record<string, unknown>, name: string, defaultValue: string): string {
  const val = args[name];
  if (typeof val === 'string') {
    return val;
  }
  return defaultValue;
}
