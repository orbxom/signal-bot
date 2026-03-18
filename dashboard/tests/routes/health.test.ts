import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createHealthRoutes } from '../../src/routes/health';

describe('health routes', () => {
  let app: express.Express;
  let mockHealthService: any;
  let mockStorage: any;

  beforeEach(() => {
    app = express();
    app.use(express.json());

    mockHealthService = {
      getHealth: vi.fn(),
    };

    mockStorage = {
      messages: { getDistinctGroupIds: vi.fn().mockReturnValue(['g1', 'g2']) },
      reminders: { listAll: vi.fn().mockReturnValue([{}, {}, {}]) },
      attachments: {
        getStats: vi.fn().mockReturnValue({
          totalSize: 1024,
          countByGroup: [{ groupId: 'g1', count: 5 }, { groupId: 'g2', count: 3 }],
        }),
      },
    };

    app.use('/api', createHealthRoutes(mockHealthService, mockStorage));
  });

  it('GET /api/health returns health data', async () => {
    mockHealthService.getHealth.mockResolvedValue({
      uptime: 1000,
      memory: { heapUsed: 500 },
      dbSize: 2048,
      signalCliReachable: true,
    });

    const res = await request(app).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body.uptime).toBe(1000);
    expect(res.body.signalCliReachable).toBe(true);
    expect(res.body.dbSize).toBe(2048);
  });

  it('GET /api/health returns 500 on error', async () => {
    mockHealthService.getHealth.mockRejectedValue(new Error('fail'));

    const res = await request(app).get('/api/health');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Health check failed');
  });

  it('GET /api/stats returns aggregate stats', async () => {
    const res = await request(app).get('/api/stats');

    expect(res.status).toBe(200);
    expect(res.body.groupCount).toBe(2);
    expect(res.body.reminderCount).toBe(3);
    expect(res.body.attachmentCount).toBe(8);
    expect(res.body.attachmentSize).toBe(1024);
  });

  it('GET /api/stats returns 500 on error', async () => {
    mockStorage.messages.getDistinctGroupIds.mockImplementation(() => {
      throw new Error('db error');
    });

    const res = await request(app).get('/api/stats');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Stats fetch failed');
  });
});
