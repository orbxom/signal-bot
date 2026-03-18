import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createFactoryRoutes } from '../../src/routes/factory';

describe('factory routes', () => {
  let app: express.Express;
  let mockFactoryService: any;

  beforeEach(() => {
    app = express();
    app.use(express.json());

    mockFactoryService = {
      getSnapshot: vi.fn().mockReturnValue({}),
    };

    app.use('/api', createFactoryRoutes(mockFactoryService));
  });

  it('GET /api/factory/runs returns snapshot', async () => {
    mockFactoryService.getSnapshot.mockReturnValue({
      'issue-42': {
        runId: 'issue-42',
        status: { currentStage: 'build' },
        event: { title: 'Fix bug' },
        diary: '',
      },
    });

    const res = await request(app).get('/api/factory/runs');

    expect(res.status).toBe(200);
    expect(res.body['issue-42']).toBeDefined();
    expect(res.body['issue-42'].status.currentStage).toBe('build');
  });

  it('GET /api/factory/runs returns empty when no runs', async () => {
    const res = await request(app).get('/api/factory/runs');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });
});
