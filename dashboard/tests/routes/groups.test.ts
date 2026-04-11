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
      messages: {
        getCount: vi.fn().mockReturnValue(0),
        getLastTimestamp: vi.fn().mockReturnValue(null),
      },
    };

    mockSignalClient = {
      listGroups: vi.fn(),
      getGroup: vi.fn(),
      quitGroup: vi.fn(),
      joinGroup: vi.fn(),
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

  it('GET /api/groups enriches with messageCount and lastActivity', async () => {
    mockSignalClient.listGroups.mockResolvedValue([
      { id: 'g1', name: 'Family', members: ['+1', '+2'] },
    ]);
    mockStorage.messages.getCount.mockReturnValue(42);
    mockStorage.messages.getLastTimestamp.mockReturnValue(1710000000000);

    const res = await request(app).get('/api/groups');

    expect(res.status).toBe(200);
    expect(res.body[0].messageCount).toBe(42);
    expect(res.body[0].lastActivity).toBe(1710000000000);
  });

  it('GET /api/groups returns null lastActivity when no messages', async () => {
    mockSignalClient.listGroups.mockResolvedValue([
      { id: 'g1', name: 'Family', members: ['+1'] },
    ]);
    mockStorage.messages.getCount.mockReturnValue(0);
    mockStorage.messages.getLastTimestamp.mockReturnValue(null);

    const res = await request(app).get('/api/groups');

    expect(res.body[0].messageCount).toBe(0);
    expect(res.body[0].lastActivity).toBeNull();
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

  describe('POST /api/groups/join', () => {
    it('joins group and returns refreshed group list', async () => {
      mockSignalClient.joinGroup.mockResolvedValue(undefined);
      mockSignalClient.listGroups
        .mockResolvedValueOnce([{ id: 'g1', name: 'Family', members: ['+1'] }])
        .mockResolvedValueOnce([
          { id: 'g1', name: 'Family', members: ['+1'] },
          { id: 'g2', name: 'New Group', members: ['+1', '+2'] },
        ]);
      mockStorage.groupSettings.get.mockReturnValue(null);
      mockStorage.personas.getActiveForGroup.mockReturnValue(null);

      const res = await request(app)
        .post('/api/groups/join')
        .send({ uri: 'https://signal.group/#abc123' });

      expect(res.status).toBe(200);
      expect(mockSignalClient.joinGroup).toHaveBeenCalledWith('https://signal.group/#abc123');
      expect(res.body.groups).toHaveLength(2);
    });

    it('returns 202 when group not found after join (admin approval pending)', async () => {
      mockSignalClient.joinGroup.mockResolvedValue(undefined);
      // listGroups called twice: before join (1 group) and after join (still 1 group — new group not yet visible)
      mockSignalClient.listGroups
        .mockResolvedValueOnce([{ id: 'g1', name: 'Family', members: ['+1'] }])
        .mockResolvedValueOnce([{ id: 'g1', name: 'Family', members: ['+1'] }]);
      mockStorage.groupSettings.get.mockReturnValue(null);
      mockStorage.personas.getActiveForGroup.mockReturnValue(null);

      const res = await request(app)
        .post('/api/groups/join')
        .send({ uri: 'https://signal.group/#needs-approval' });

      expect(res.status).toBe(202);
      expect(res.body.message).toMatch(/awaiting admin approval/);
    });

    it('returns 400 for missing uri', async () => {
      const res = await request(app)
        .post('/api/groups/join')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid Signal group invite link/);
    });

    it('returns 400 for malformed uri', async () => {
      const res = await request(app)
        .post('/api/groups/join')
        .send({ uri: 'https://example.com/not-a-signal-link' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid Signal group invite link/);
    });

    it('returns 422 when signal-cli rejects the link', async () => {
      mockSignalClient.listGroups.mockResolvedValue([]);
      mockSignalClient.joinGroup.mockRejectedValue(new Error('Signal RPC error: Invalid group link'));

      const res = await request(app)
        .post('/api/groups/join')
        .send({ uri: 'https://signal.group/#expired' });

      expect(res.status).toBe(422);
      expect(res.body.error).toMatch(/Invalid group link/);
    });

    it('returns 500 on unexpected errors', async () => {
      mockSignalClient.listGroups.mockResolvedValue([]);
      mockSignalClient.joinGroup.mockRejectedValue(new TypeError('Cannot read properties of undefined'));

      const res = await request(app)
        .post('/api/groups/join')
        .send({ uri: 'https://signal.group/#abc123' });

      expect(res.status).toBe(500);
    });

    it('returns 503 when signal-cli is unreachable', async () => {
      mockSignalClient.listGroups.mockResolvedValue([]);
      mockSignalClient.joinGroup.mockRejectedValue(new Error('Signal API error: ECONNREFUSED'));

      const res = await request(app)
        .post('/api/groups/join')
        .send({ uri: 'https://signal.group/#abc123' });

      expect(res.status).toBe(503);
    });
  });

  describe('PATCH /api/groups/:id/settings - customTriggers parsing', () => {
    it('should convert comma-separated string to array', async () => {
      mockStorage.groupSettings.get.mockReturnValue({ enabled: true });

      const res = await request(app)
        .patch('/api/groups/g1/settings')
        .send({ customTriggers: 'hey bot, yo bot, sup' });

      expect(res.status).toBe(200);
      expect(mockStorage.groupSettings.upsert).toHaveBeenCalledWith('g1', expect.objectContaining({
        customTriggers: ['hey bot', 'yo bot', 'sup'],
      }));
    });

    it('should pass through an array as-is', async () => {
      mockStorage.groupSettings.get.mockReturnValue({ enabled: true });

      const res = await request(app)
        .patch('/api/groups/g1/settings')
        .send({ customTriggers: ['hey bot', 'yo bot'] });

      expect(res.status).toBe(200);
      expect(mockStorage.groupSettings.upsert).toHaveBeenCalledWith('g1', expect.objectContaining({
        customTriggers: ['hey bot', 'yo bot'],
      }));
    });

    it('should pass through null as-is', async () => {
      mockStorage.groupSettings.get.mockReturnValue({ enabled: true });

      const res = await request(app)
        .patch('/api/groups/g1/settings')
        .send({ customTriggers: null });

      expect(res.status).toBe(200);
      expect(mockStorage.groupSettings.upsert).toHaveBeenCalledWith('g1', expect.objectContaining({
        customTriggers: null,
      }));
    });

    it('should filter out empty strings after splitting', async () => {
      mockStorage.groupSettings.get.mockReturnValue({ enabled: true });

      const res = await request(app)
        .patch('/api/groups/g1/settings')
        .send({ customTriggers: 'hey bot, , ,yo bot' });

      expect(res.status).toBe(200);
      expect(mockStorage.groupSettings.upsert).toHaveBeenCalledWith('g1', expect.objectContaining({
        customTriggers: ['hey bot', 'yo bot'],
      }));
    });

    it('should pass through undefined when not provided', async () => {
      mockStorage.groupSettings.get.mockReturnValue({ enabled: true });

      const res = await request(app)
        .patch('/api/groups/g1/settings')
        .send({ enabled: true });

      expect(res.status).toBe(200);
      expect(mockStorage.groupSettings.upsert).toHaveBeenCalledWith('g1', expect.objectContaining({
        customTriggers: undefined,
      }));
    });
  });

  describe('PATCH /api/groups/:id/settings - contextWindowSize validation', () => {
    it('should reject negative contextWindowSize', async () => {
      const res = await request(app)
        .patch('/api/groups/g1/settings')
        .send({ contextWindowSize: -5 });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/contextWindowSize/);
    });

    it('should reject zero contextWindowSize', async () => {
      const res = await request(app)
        .patch('/api/groups/g1/settings')
        .send({ contextWindowSize: 0 });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/contextWindowSize/);
    });

    it('should reject non-integer contextWindowSize', async () => {
      const res = await request(app)
        .patch('/api/groups/g1/settings')
        .send({ contextWindowSize: 3.5 });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/contextWindowSize/);
    });

    it('should accept valid positive integer contextWindowSize', async () => {
      mockStorage.groupSettings.get.mockReturnValue({ enabled: true, contextWindowSize: 50 });

      const res = await request(app)
        .patch('/api/groups/g1/settings')
        .send({ contextWindowSize: 50 });

      expect(res.status).toBe(200);
      expect(mockStorage.groupSettings.upsert).toHaveBeenCalledWith('g1', expect.objectContaining({
        contextWindowSize: 50,
      }));
    });

    it('should accept null contextWindowSize (reset to default)', async () => {
      mockStorage.groupSettings.get.mockReturnValue({ enabled: true, contextWindowSize: null });

      const res = await request(app)
        .patch('/api/groups/g1/settings')
        .send({ contextWindowSize: null });

      expect(res.status).toBe(200);
    });

    it('should accept undefined contextWindowSize (not provided)', async () => {
      mockStorage.groupSettings.get.mockReturnValue({ enabled: true });

      const res = await request(app)
        .patch('/api/groups/g1/settings')
        .send({ enabled: true });

      expect(res.status).toBe(200);
    });
  });

  describe('with null signalClient (BOT_PHONE_NUMBER not set)', () => {
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
        messages: {
          getCount: vi.fn().mockReturnValue(0),
          getLastTimestamp: vi.fn().mockReturnValue(null),
        },
      };

      app.use('/api', createGroupRoutes(mockStorage, null as any));
    });

    it('GET /api/groups returns 503', async () => {
      const res = await request(app).get('/api/groups');

      expect(res.status).toBe(503);
      expect(res.body.error).toMatch(/not configured/i);
    });

    it('GET /api/groups/:id returns 503', async () => {
      const res = await request(app).get('/api/groups/g1');

      expect(res.status).toBe(503);
    });

    it('POST /api/groups/join returns 503', async () => {
      const res = await request(app)
        .post('/api/groups/join')
        .send({ uri: 'https://signal.group/#test' });

      expect(res.status).toBe(503);
    });

    it('POST /api/groups/:id/leave returns 503', async () => {
      const res = await request(app).post('/api/groups/g1/leave');

      expect(res.status).toBe(503);
    });

    it('PATCH /api/groups/:id/settings still works without signal client', async () => {
      mockStorage.groupSettings.get.mockReturnValue({ enabled: true });

      const res = await request(app)
        .patch('/api/groups/g1/settings')
        .send({ enabled: false });

      expect(res.status).toBe(200);
    });
  });
});
