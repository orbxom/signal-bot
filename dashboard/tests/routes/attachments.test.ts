import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createAttachmentRoutes } from '../../src/routes/attachments';

describe('attachment routes', () => {
  let app: express.Express;
  let mockStorage: any;

  beforeEach(() => {
    app = express();
    app.use(express.json());

    mockStorage = {
      attachments: {
        listMetadata: vi.fn().mockReturnValue([]),
        getStats: vi.fn().mockReturnValue({ totalSize: 0, countByGroup: [] }),
        get: vi.fn(),
        deleteById: vi.fn().mockReturnValue(true),
      },
    };

    app.use('/api', createAttachmentRoutes(mockStorage));
  });

  it('GET /api/attachments returns metadata list', async () => {
    mockStorage.attachments.listMetadata.mockReturnValue([{ id: 'abc', contentType: 'image/png' }]);

    const res = await request(app).get('/api/attachments?groupId=g1');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('GET /api/attachments/stats returns stats', async () => {
    mockStorage.attachments.getStats.mockReturnValue({ totalSize: 5000, countByGroup: [] });

    const res = await request(app).get('/api/attachments/stats');

    expect(res.status).toBe(200);
    expect(res.body.totalSize).toBe(5000);
  });

  it('GET /api/attachments/:id/image returns image data', async () => {
    mockStorage.attachments.get.mockReturnValue({
      id: 'abc',
      contentType: 'image/png',
      data: Buffer.from('fake-image'),
    });

    const res = await request(app).get('/api/attachments/abc/image');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
  });

  it('GET /api/attachments/:id/image returns 404 when not found', async () => {
    mockStorage.attachments.get.mockReturnValue(null);

    const res = await request(app).get('/api/attachments/missing/image');

    expect(res.status).toBe(404);
  });

  it('DELETE /api/attachments/:id deletes', async () => {
    const res = await request(app).delete('/api/attachments/abc');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('DELETE /api/attachments/:id returns 404 when not found', async () => {
    mockStorage.attachments.deleteById.mockReturnValue(false);

    const res = await request(app).delete('/api/attachments/missing');

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });
});
