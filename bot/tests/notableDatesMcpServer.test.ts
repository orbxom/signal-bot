import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  initializeServer,
  sendAndReceive,
  spawnMcpServer as spawnServer,
} from './helpers/mcpTestHelpers';

describe('Notable Dates MCP Server', () => {
  let proc: ChildProcess | null = null;

  afterEach(() => {
    if (proc) {
      proc.kill();
      proc = null;
    }
  });

  function spawn(env: Record<string, string> = {}): ChildProcess {
    proc = spawnServer('mcp/servers/notableDates.ts', {
      TZ: 'Australia/Sydney',
      ...env,
    });
    return proc;
  }

  it('initializes and lists one tool', async () => {
    const p = spawn();
    await initializeServer(p);
    const result = await sendAndReceive(p, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    });
    expect(result.result.tools).toHaveLength(1);
    expect(result.result.tools[0].name).toBe('get_notable_dates');
  });

  it('returns curated observances for International Womens Day (no API needed)', async () => {
    const p = spawn();
    await initializeServer(p);
    const result = await sendAndReceive(p, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'get_notable_dates',
        arguments: { date: '2026-03-08' },
      },
    });
    const text = result.result.content[0].text;
    expect(text).toContain("International Women's Day");
    expect(result.result.isError).toBeFalsy();
  });

  it('returns Australia Day from curated list (no API needed)', async () => {
    const p = spawn();
    await initializeServer(p);
    const result = await sendAndReceive(p, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'get_notable_dates',
        arguments: { date: '2026-01-26' },
      },
    });
    const text = result.result.content[0].text;
    expect(text).toContain('Australia Day');
    expect(result.result.isError).toBeFalsy();
  });

  it('returns results for today when no date provided', async () => {
    const p = spawn();
    await initializeServer(p);
    const result = await sendAndReceive(p, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'get_notable_dates',
        arguments: {},
      },
    });
    expect(result.result.content[0].type).toBe('text');
    expect(result.result.isError).toBeFalsy();
  });

  it('returns error for invalid date format', async () => {
    const p = spawn();
    await initializeServer(p);
    const result = await sendAndReceive(p, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'get_notable_dates',
        arguments: { date: 'not-a-date' },
      },
    });
    expect(result.result.isError).toBe(true);
  });

  it('returns error for impossible date like Feb 30', async () => {
    const p = spawn();
    await initializeServer(p);
    const result = await sendAndReceive(p, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'get_notable_dates',
        arguments: { date: '2026-02-30' },
      },
    });
    expect(result.result.isError).toBe(true);
  });

  it('handles date with no observances gracefully', async () => {
    const p = spawn();
    await initializeServer(p);
    const result = await sendAndReceive(p, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'get_notable_dates',
        arguments: { date: '2026-01-15' },
      },
    });
    expect(result.result.content[0].type).toBe('text');
    expect(result.result.isError).toBeFalsy();
  });

  it('still returns curated data for extreme year when API may fail', async () => {
    const p = spawn();
    await initializeServer(p);
    const result = await sendAndReceive(p, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'get_notable_dates',
        arguments: { date: '1900-12-25' },
      },
    });
    const text = result.result.content[0].text;
    expect(text).toContain('Christmas');
    expect(result.result.isError).toBeFalsy();
  });

  it('returns error for unknown tool', async () => {
    const p = spawn();
    await initializeServer(p);
    const result = await sendAndReceive(p, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'nonexistent_tool',
        arguments: {},
      },
    });
    expect(result.result.isError).toBe(true);
  });
});
