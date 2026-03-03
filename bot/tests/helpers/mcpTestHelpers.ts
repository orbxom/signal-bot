import { type ChildProcess, spawn } from 'node:child_process';
import { join } from 'node:path';

export function spawnMcpServer(serverFile: string, env: Record<string, string> = {}): ChildProcess {
  return spawn('npx', ['tsx', join(__dirname, '../../src', serverFile)], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

export function sendAndReceive(
  proc: ChildProcess,
  message: object,
  timeoutMs = 10000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timeout waiting for MCP response')), timeoutMs);
    const handler = (data: Buffer) => {
      const line = data.toString().trim();
      if (!line) return;
      try {
        const response = JSON.parse(line);
        clearTimeout(timeout);
        proc.stdout?.removeListener('data', handler);
        resolve(response);
      } catch {
        // partial data, wait for more
      }
    };
    proc.stdout?.on('data', handler);
    proc.stdin?.write(`${JSON.stringify(message)}\n`);
  });
}

export async function initializeServer(proc: ChildProcess): Promise<void> {
  await sendAndReceive(proc, {
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
  });
  proc.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
}
