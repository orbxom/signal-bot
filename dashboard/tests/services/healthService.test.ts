import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import { HealthService } from '../../src/services/healthService';

vi.mock('node:fs');

describe('HealthService', () => {
  let healthService: HealthService;
  let mockStorage: any;
  let mockSignalClient: any;
  const dbPath = '/tmp/test.db';

  beforeEach(() => {
    vi.restoreAllMocks();
    mockStorage = {};
    mockSignalClient = {
      listGroups: vi.fn(),
    };
    healthService = new HealthService(mockStorage, mockSignalClient, dbPath);
  });

  it('returns health with uptime, memory, dbSize, and signalCliReachable', async () => {
    mockSignalClient.listGroups.mockResolvedValue([]);
    vi.mocked(fs.statSync).mockReturnValue({ size: 1024 } as any);

    const health = await healthService.getHealth();

    expect(health).toHaveProperty('uptime');
    expect(health.uptime).toBeGreaterThanOrEqual(0);
    expect(health).toHaveProperty('memory');
    expect(health.memory).toHaveProperty('heapUsed');
    expect(health.dbSize).toBe(1024);
    expect(health.signalCliReachable).toBe(true);
  });

  it('reports signalCliReachable as false when listGroups throws', async () => {
    mockSignalClient.listGroups.mockRejectedValue(new Error('connection refused'));
    vi.mocked(fs.statSync).mockReturnValue({ size: 512 } as any);

    const health = await healthService.getHealth();

    expect(health.signalCliReachable).toBe(false);
    expect(health.dbSize).toBe(512);
  });

  it('reports dbSize as 0 when file does not exist', async () => {
    mockSignalClient.listGroups.mockResolvedValue([]);
    vi.mocked(fs.statSync).mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const health = await healthService.getHealth();

    expect(health.dbSize).toBe(0);
    expect(health.signalCliReachable).toBe(true);
  });

  it('uptime increases over time', async () => {
    mockSignalClient.listGroups.mockResolvedValue([]);
    vi.mocked(fs.statSync).mockReturnValue({ size: 0 } as any);

    const h1 = await healthService.getHealth();
    // Small delay to ensure uptime changes
    await new Promise((r) => setTimeout(r, 10));
    const h2 = await healthService.getHealth();

    expect(h2.uptime).toBeGreaterThanOrEqual(h1.uptime);
  });

  it('reports signalCliReachable as false when signalClient is null', async () => {
    const nullClientHealth = new HealthService(mockStorage, null as any, dbPath);
    vi.mocked(fs.statSync).mockReturnValue({ size: 256 } as any);

    const health = await nullClientHealth.getHealth();

    expect(health.signalCliReachable).toBe(false);
    expect(health.dbSize).toBe(256);
  });
});
