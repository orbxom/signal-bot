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
        update: vi.fn(),
        deleteById: vi.fn().mockReturnValue(true),
      },
    };

    app.use('/api', createMemoryRoutes(mockStorage));
  });

  it('GET /api/memories returns all memories', async () => {
    mockStorage.memories.listAll.mockReturnValue([
      { id: 1, groupId: 'g1', title: 'pets', type: 'text', tags: [] },
    ]);

    const res = await request(app).get('/api/memories');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { id: 1, groupId: 'g1', title: 'pets', type: 'text', tags: [] },
    ]);
    expect(mockStorage.memories.listAll).toHaveBeenCalledWith({
      groupId: undefined,
      limit: undefined,
      offset: undefined,
    });
  });

  it('GET /api/memories passes groupId filter', async () => {
    mockStorage.memories.listAll.mockReturnValue([]);

    await request(app).get('/api/memories?groupId=g1&limit=10&offset=5');

    expect(mockStorage.memories.listAll).toHaveBeenCalledWith({
      groupId: 'g1',
      limit: 10,
      offset: 5,
    });
  });

  it('PUT /api/memories/:id updates memory', async () => {
    mockStorage.memories.update.mockReturnValue({
      id: 42,
      groupId: 'g1',
      title: 'pets',
      type: 'text',
      tags: [],
    });

    const res = await request(app)
      .put('/api/memories/42')
      .send({ title: 'pets', description: 'about pets', content: 'we have a dog', type: 'text' });

    expect(res.status).toBe(200);
    expect(mockStorage.memories.update).toHaveBeenCalledWith(42, {
      title: 'pets',
      description: 'about pets',
      content: 'we have a dog',
      type: 'text',
    });
  });

  it('PUT /api/memories/:id returns 404 when not found', async () => {
    mockStorage.memories.update.mockReturnValue(null);

    const res = await request(app)
      .put('/api/memories/999')
      .send({ title: 'nope' });

    expect(res.status).toBe(404);
  });

  it('DELETE /api/memories/:id deletes by id', async () => {
    const res = await request(app).delete('/api/memories/42');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockStorage.memories.deleteById).toHaveBeenCalledWith(42);
  });

  it('DELETE /api/memories/:id returns 404 when not found', async () => {
    mockStorage.memories.deleteById.mockReturnValue(false);

    const res = await request(app).delete('/api/memories/999');

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });
});
