import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChildProcess, spawn } from 'node:child_process';
import http from 'node:http';

const PORT = 19876; // unlikely to conflict
const GROUP_ID = 'kKWs+FQPBZKe7N7CdxMjNAAjE2uWEmtBij55MOfWFU4=';

function rpc(method: string, params: Record<string, unknown> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', method, params, id: '1' });
    const req = http.request(
      { hostname: 'localhost', port: PORT, path: '/api/v1/rpc', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const json = JSON.parse(Buffer.concat(chunks).toString());
          resolve(json);
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

describe('mock signal server RPC handlers', () => {
  let proc: ChildProcess;

  beforeAll(async () => {
    proc = spawn('npx', ['tsx', 'src/mock/signalServer.ts'], {
      cwd: '/home/zknowles/personal/signal-bot/bot',
      env: { ...process.env, MOCK_SIGNAL_PORT: String(PORT) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Wait for server to be ready
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Mock server did not start')), 5000);
      proc.stdout?.on('data', (data: Buffer) => {
        if (data.toString().includes('Listening on')) {
          clearTimeout(timeout);
          resolve();
        }
      });
      proc.on('error', reject);
    });
  });

  afterAll(() => {
    proc?.kill('SIGTERM');
  });

  it('getGroup returns group data for known group', async () => {
    const res = await rpc('getGroup', { groupId: GROUP_ID });
    expect(res.result).toBeDefined();
    expect(res.result.id).toBe(GROUP_ID);
    expect(res.result.name).toBe('Bot Test');
    expect(res.result.members).toContain('+61400111222');
  });

  it('getGroup returns error for unknown group', async () => {
    const res = await rpc('getGroup', { groupId: 'unknown-id' });
    expect(res.error).toBeDefined();
  });

  it('quitGroup returns success', async () => {
    const res = await rpc('quitGroup', { groupId: GROUP_ID });
    expect(res.result).toEqual({});
  });

  it('joinGroup returns success', async () => {
    const res = await rpc('joinGroup', { uri: 'https://signal.group/#test' });
    expect(res.result).toEqual({});
  });

  it('listGroups returns groups with members array', async () => {
    const res = await rpc('listGroups');
    expect(res.result).toBeDefined();
    expect(res.result).toBeInstanceOf(Array);
    expect(res.result.length).toBeGreaterThan(0);
    expect(res.result[0]).toHaveProperty('id', GROUP_ID);
    expect(res.result[0]).toHaveProperty('name', 'Bot Test');
    expect(res.result[0]).toHaveProperty('members');
    expect(res.result[0].members).toContain('+61400111222');
  });
});
