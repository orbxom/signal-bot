import { catchErrors, getErrorMessage } from './result';
import type { ToolResult } from './types';

export async function sendToolNotification(message: string, success = true): Promise<void> {
  try {
    if (process.env.TOOL_NOTIFICATIONS_ENABLED !== '1') return;

    const { SIGNAL_CLI_URL, SIGNAL_ACCOUNT, MCP_GROUP_ID } = process.env;
    if (!SIGNAL_CLI_URL || !SIGNAL_ACCOUNT || !MCP_GROUP_ID) return;

    const prefix = success ? 'Done' : 'Failed';
    await fetch(`${SIGNAL_CLI_URL}/api/v1/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'send',
        params: {
          account: SIGNAL_ACCOUNT,
          groupId: MCP_GROUP_ID,
          message: `${prefix} — ${message}`,
        },
        id: `notify-${Date.now()}`,
      }),
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    // Silent — notifications are best-effort
  }
}

export async function withNotification(
  onSuccess: string | ((result: ToolResult) => string),
  onError: string,
  fn: () => ToolResult | Promise<ToolResult>,
  errorPrefix?: string,
): Promise<ToolResult> {
  const result = await catchErrors(fn, errorPrefix);

  if (result.isError) {
    const errText =
      result.content[0] && 'text' in result.content[0] ? result.content[0].text : 'unknown error';
    sendToolNotification(`${onError}: ${errText}`, false);
  } else {
    const msg = typeof onSuccess === 'function' ? onSuccess(result) : onSuccess;
    sendToolNotification(msg);
  }

  return result;
}
