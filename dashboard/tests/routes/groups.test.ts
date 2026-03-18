import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createGroupRoutes } from '../../src/routes/groups';

describe('groups routes', () => {
  let app: express.Express;
  let mockStorage: any;
  let mockSignalClient: any;

  beforeEach(() => {
    app = express();
    app.use(express.json());

    mockStorage = {
      groupSettings: {
        get: vi.fn().mockReturnValue(null),
        upsert: vi.fn(),
      },
      personas: {
        getActiveForGroup: vi.fn().mockReturnValue(null),
      },
    };

    mockSignalClient = {
      listGroups: vi.fn(),
      getGroup: vi.fn(),
      quitGroup: vi.fn(),
    };

    app.use('/api', createGroupRoutes(mockStorage, mockSignalClient));
  });

  it('GET /api/groups returns enriched group list', async () => {
    mockSignalClient.listGroups.mockResolvedValue([
      { id: 'g1', name: 'Family', members: ['+1', '+2'] },
    ]);
    mockStorage.groupSettings.get.mockReturnValue({ enabled: true, toolNotifications: true });
    mockStorage.personas.getActiveForGroup.mockReturnValue({ name: 'Friendly Bot' });

    const res = await request(app).get('/api/groups');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].name).toBe('Family');
    expect(res.body[0].enabled).toBe(true);
    expect(res.body[0].activePersona).toBe('Friendly Bot');
  });

  it('GET /api/groups returns 503 when signal-cli unreachable', async () => {
    mockSignalClient.listGroups.mockRejectedValue(new Error('connection refused'));

    const res = await request(app).get('/api/groups');

    expect(res.status).toBe(503);
  });

  it('GET /api/groups/:id returns group detail with settings', async () => {
    mockSignalClient.getGroup.mockResolvedValue({ id: 'g1', name: 'Family' });
    mockStorage.groupSettings.get.mockReturnValue({ enabled: true });
    mockStorage.personas.getActiveForGroup.mockReturnValue({ name: 'Default' });

    const res = await request(app).get('/api/groups/g1');

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Family');
    expect(res.body.settings).toEqual({ enabled: true });
  });

  it('PATCH /api/groups/:id/settings updates settings', async () => {
    mockStorage.groupSettings.get.mockReturnValue({ enabled: false, toolNotifications: false });

    const res = await request(app)
      .patch('/api/groups/g1/settings')
      .send({ enabled: false, toolNotifications: false });

    expect(res.status).toBe(200);
    expect(mockStorage.groupSettings.upsert).toHaveBeenCalledWith('g1', {
      enabled: false,
      customTriggers: undefined,
      contextWindowSize: undefined,
      toolNotifications: false,
    });
  });

  it('POST /api/groups/:id/leave quits group and disables', async () => {
    mockSignalClient.quitGroup.mockResolvedValue(undefined);

    const res = await request(app).post('/api/groups/g1/leave');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockSignalClient.quitGroup).toHaveBeenCalledWith('g1');
    expect(mockStorage.groupSettings.upsert).toHaveBeenCalledWith('g1', { enabled: false });
  });
});
