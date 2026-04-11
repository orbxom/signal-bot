import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createReminderRoutes } from '../../src/routes/reminders';

describe('reminder routes', () => {
  let app: express.Express;
  let mockStorage: any;

  beforeEach(() => {
    app = express();
    app.use(express.json());

    mockStorage = {
      reminders: {
        listAll: vi.fn().mockReturnValue([]),
        cancel: vi.fn().mockReturnValue(true),
      },
      recurringReminders: {
        listAll: vi.fn().mockReturnValue([]),
        cancel: vi.fn().mockReturnValue(true),
        resetFailures: vi.fn().mockReturnValue(true),
      },
    };

    app.use('/api', createReminderRoutes(mockStorage));
  });

  it('GET /api/reminders returns list with filters', async () => {
    mockStorage.reminders.listAll.mockReturnValue([{ id: 1 }]);

    const res = await request(app).get('/api/reminders?groupId=g1&status=pending&limit=10');

    expect(res.status).toBe(200);
    expect(mockStorage.reminders.listAll).toHaveBeenCalledWith({
      groupId: 'g1',
      status: 'pending',
      limit: 10,
      offset: undefined,
    });
  });

  it('DELETE /api/reminders/:id cancels a reminder', async () => {
    const res = await request(app).delete('/api/reminders/5?groupId=g1');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockStorage.reminders.cancel).toHaveBeenCalledWith(5, 'g1');
  });

  it('DELETE /api/reminders/:id returns 400 without groupId', async () => {
    const res = await request(app).delete('/api/reminders/5');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('groupId required');
  });

  it('GET /api/recurring-reminders returns list', async () => {
    mockStorage.recurringReminders.listAll.mockReturnValue([{ id: 1 }]);

    const res = await request(app).get('/api/recurring-reminders');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 1 }]);
  });

  it('GET /api/recurring-reminders returns promptText field (not prompt)', async () => {
    mockStorage.recurringReminders.listAll.mockReturnValue([{
      id: 1,
      groupId: 'g1',
      requester: '+61400111222',
      promptText: 'Check the weather forecast',
      cronExpression: '0 7 * * *',
      timezone: 'Australia/Sydney',
      nextDueAt: 1710900000000,
      status: 'active',
      consecutiveFailures: 0,
      lastFiredAt: null,
      lastInFlightAt: null,
      createdAt: 1710800000000,
      updatedAt: 1710800000000,
    }]);

    const res = await request(app).get('/api/recurring-reminders');

    expect(res.status).toBe(200);
    expect(res.body[0]).toHaveProperty('promptText', 'Check the weather forecast');
    expect(res.body[0]).not.toHaveProperty('prompt');
  });


  it('DELETE /api/recurring-reminders/:id cancels', async () => {
    const res = await request(app).delete('/api/recurring-reminders/3?groupId=g1');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('DELETE /api/recurring-reminders/:id returns 400 without groupId', async () => {
    const res = await request(app).delete('/api/recurring-reminders/3');

    expect(res.status).toBe(400);
  });

  it('POST /api/recurring-reminders/:id/reset-failures resets', async () => {
    const res = await request(app).post('/api/recurring-reminders/3/reset-failures');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockStorage.recurringReminders.resetFailures).toHaveBeenCalledWith(3);
  });

  it('GET /api/reminders returns reminderText field (not text)', async () => {
    mockStorage.reminders.listAll.mockReturnValue([{
      id: 1,
      groupId: 'g1',
      requester: '+61400111222',
      reminderText: 'Buy milk',
      dueAt: 1710900000000,
      status: 'pending',
      retryCount: 0,
      mode: 'simple',
    }]);

    const res = await request(app).get('/api/reminders?groupId=g1');

    expect(res.status).toBe(200);
    expect(res.body[0]).toHaveProperty('reminderText', 'Buy milk');
    expect(res.body[0]).not.toHaveProperty('text');
  });

  it('DELETE /api/reminders/:id returns 404 when reminder not found', async () => {
    mockStorage.reminders.cancel.mockReturnValue(false);

    const res = await request(app).delete('/api/reminders/999?groupId=g1');

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it('DELETE /api/recurring-reminders/:id returns 404 when not found', async () => {
    mockStorage.recurringReminders.cancel.mockReturnValue(false);

    const res = await request(app).delete('/api/recurring-reminders/999?groupId=g1');

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it('POST /api/recurring-reminders/:id/reset-failures returns 404 when not found', async () => {
    mockStorage.recurringReminders.resetFailures.mockReturnValue(false);

    const res = await request(app).post('/api/recurring-reminders/999/reset-failures');

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });
});
