import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createMemoryRoutes } from '../../src/routes/memories';

describe('memory routes', () => {
  let app: express.Express;
  let mockStorage: any;

  beforeEach(() => {
    app = express();
    app.use(express.json());

    mockStorage = {
      memories: {
        listAll: vi.fn().mockReturnValue([]),
        upsert: vi.fn(),
        delete: vi.fn().mockReturnValue(true),
      },
    };

    app.use('/api', createMemoryRoutes(mockStorage));
  });

  it('GET /api/memories returns list with filters', async () => {
    mockStorage.memories.listAll.mockReturnValue([{ topic: 'pets' }]);

    const res = await request(app).get('/api/memories?groupId=g1');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ topic: 'pets' }]);
  });

  it('PUT /api/memories/:groupId/:topic upserts', async () => {
    mockStorage.memories.upsert.mockReturnValue({ groupId: 'g1', topic: 'pets', content: 'dog' });

    const res = await request(app)
      .put('/api/memories/g1/pets')
      .send({ content: 'dog' });

    expect(res.status).toBe(200);
    expect(mockStorage.memories.upsert).toHaveBeenCalledWith('g1', 'pets', 'dog');
  });

  it('DELETE /api/memories/:groupId/:topic deletes', async () => {
    const res = await request(app).delete('/api/memories/g1/pets');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
