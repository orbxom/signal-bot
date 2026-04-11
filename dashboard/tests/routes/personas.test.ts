import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createPersonaRoutes } from '../../src/routes/personas';

describe('persona routes', () => {
  let app: express.Express;
  let mockStorage: any;

  beforeEach(() => {
    app = express();
    app.use(express.json());

    mockStorage = {
      personas: {
        list: vi.fn().mockReturnValue([]),
        create: vi.fn(),
        update: vi.fn().mockReturnValue(true),
        delete: vi.fn().mockReturnValue(true),
        setActive: vi.fn(),
      },
    };

    app.use('/api', createPersonaRoutes(mockStorage));
  });

  it('GET /api/personas returns list', async () => {
    mockStorage.personas.list.mockReturnValue([{ id: 1, name: 'Bot' }]);

    const res = await request(app).get('/api/personas');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 1, name: 'Bot' }]);
  });

  it('POST /api/personas creates persona', async () => {
    mockStorage.personas.create.mockReturnValue({ id: 2, name: 'Fun Bot' });

    const res = await request(app)
      .post('/api/personas')
      .send({ name: 'Fun Bot', description: 'A fun persona', tags: 'fun,casual' });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Fun Bot');
  });

  it('POST /api/personas returns 400 on error', async () => {
    mockStorage.personas.create.mockImplementation(() => {
      throw new Error('Name already exists');
    });

    const res = await request(app)
      .post('/api/personas')
      .send({ name: 'Dup', description: '', tags: '' });

    expect(res.status).toBe(400);
  });

  it('PUT /api/personas/:id updates', async () => {
    const res = await request(app)
      .put('/api/personas/1')
      .send({ name: 'Updated', description: 'new', tags: '' });

    expect(res.status).toBe(200);
    expect(mockStorage.personas.update).toHaveBeenCalledWith(1, 'Updated', 'new', '');
  });

  it('DELETE /api/personas/:id deletes', async () => {
    const res = await request(app).delete('/api/personas/1');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('POST /api/groups/:groupId/persona sets active', async () => {
    const res = await request(app)
      .post('/api/groups/g1/persona')
      .send({ personaId: 2 });

    expect(res.status).toBe(200);
    expect(mockStorage.personas.setActive).toHaveBeenCalledWith('g1', 2);
  });

  it('PUT /api/personas/:id returns 404 when persona not found', async () => {
    mockStorage.personas.update.mockReturnValue(false);

    const res = await request(app)
      .put('/api/personas/999')
      .send({ name: 'Ghost', description: '', tags: '' });

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it('DELETE /api/personas/:id returns 404 when persona not found', async () => {
    mockStorage.personas.delete.mockReturnValue(false);

    const res = await request(app).delete('/api/personas/999');

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });
});
