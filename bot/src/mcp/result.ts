import type { ToolResult } from './types';

export { estimateTokens } from '../utils/tokens';

/** Extract the text from the first content block of a ToolResult, or '' if missing. */
export function resultText(result: ToolResult): string {
  const block = result.content[0];
  return block && 'text' in block ? block.text : '';
}

export function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

export function error(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

export function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error';
}

export function catchErrors(
  fn: () => ToolResult | Promise<ToolResult>,
  prefix?: string,
): ToolResult | Promise<ToolResult> {
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.catch(err => {
        const msg = prefix ? `${prefix}: ${getErrorMessage(err)}` : getErrorMessage(err);
        return error(msg);
      });
    }
    return result;
  } catch (err) {
    const msg = prefix ? `${prefix}: ${getErrorMessage(err)}` : getErrorMessage(err);
    return error(msg);
  }
}
