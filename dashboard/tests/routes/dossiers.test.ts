import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createDossierRoutes } from '../../src/routes/dossiers';

describe('dossier routes', () => {
  let app: express.Express;
  let mockStorage: any;

  beforeEach(() => {
    app = express();
    app.use(express.json());

    mockStorage = {
      dossiers: {
        listAll: vi.fn().mockReturnValue([]),
        get: vi.fn(),
        upsert: vi.fn(),
        delete: vi.fn().mockReturnValue(true),
      },
    };

    app.use('/api', createDossierRoutes(mockStorage));
  });

  it('GET /api/dossiers returns list with filters', async () => {
    mockStorage.dossiers.listAll.mockReturnValue([{ id: 1, personId: 'alice' }]);

    const res = await request(app).get('/api/dossiers?groupId=g1');

    expect(res.status).toBe(200);
    expect(mockStorage.dossiers.listAll).toHaveBeenCalledWith({
      groupId: 'g1',
      limit: undefined,
      offset: undefined,
    });
  });

  it('GET /api/dossiers/:groupId/:personId returns dossier', async () => {
    mockStorage.dossiers.get.mockReturnValue({ personId: 'alice', notes: 'test' });

    const res = await request(app).get('/api/dossiers/g1/alice');

    expect(res.status).toBe(200);
    expect(res.body.personId).toBe('alice');
  });

  it('GET /api/dossiers/:groupId/:personId returns 404 when not found', async () => {
    mockStorage.dossiers.get.mockReturnValue(null);

    const res = await request(app).get('/api/dossiers/g1/nobody');

    expect(res.status).toBe(404);
  });

  it('PUT /api/dossiers/:groupId/:personId upserts', async () => {
    mockStorage.dossiers.upsert.mockReturnValue({ personId: 'alice', displayName: 'Alice', notes: 'Updated' });

    const res = await request(app)
      .put('/api/dossiers/g1/alice')
      .send({ displayName: 'Alice', notes: 'Updated' });

    expect(res.status).toBe(200);
    expect(mockStorage.dossiers.upsert).toHaveBeenCalledWith('g1', 'alice', 'Alice', 'Updated');
  });

  it('DELETE /api/dossiers/:groupId/:personId deletes', async () => {
    const res = await request(app).delete('/api/dossiers/g1/alice');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
