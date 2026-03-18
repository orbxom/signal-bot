import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createMessageRoutes } from '../../src/routes/messages';

describe('message routes', () => {
  let app: express.Express;
  let mockStorage: any;

  beforeEach(() => {
    app = express();
    app.use(express.json());

    mockStorage = {
      messages: {
        search: vi.fn().mockReturnValue([]),
        getByDateRange: vi.fn().mockReturnValue([]),
      },
    };

    app.use('/api', createMessageRoutes(mockStorage));
  });

  it('GET /api/messages returns 400 without groupId', async () => {
    const res = await request(app).get('/api/messages');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('groupId required');
  });

  it('GET /api/messages returns messages by date range', async () => {
    mockStorage.messages.getByDateRange.mockReturnValue([{ id: 1, content: 'hello' }]);

    const res = await request(app).get('/api/messages?groupId=g1');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 1, content: 'hello' }]);
    expect(mockStorage.messages.getByDateRange).toHaveBeenCalled();
  });

  it('GET /api/messages with search uses search method', async () => {
    mockStorage.messages.search.mockReturnValue([{ id: 2, content: 'found it' }]);

    const res = await request(app).get('/api/messages?groupId=g1&search=found');

    expect(res.status).toBe(200);
    expect(mockStorage.messages.search).toHaveBeenCalledWith('g1', 'found', expect.any(Object));
  });

  it('GET /api/messages caps limit at 200', async () => {
    await request(app).get('/api/messages?groupId=g1&limit=500');

    expect(mockStorage.messages.getByDateRange).toHaveBeenCalledWith(
      'g1', 0, Number.MAX_SAFE_INTEGER, 200,
    );
  });
});
