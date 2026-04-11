import { Router } from 'express';
import type { Storage } from '../../../bot/src/storage';

export function createAttachmentRoutes(storage: Storage): Router {
  const router = Router();

  router.get('/attachments', (req, res) => {
    const { groupId, limit, offset } = req.query;
    const attachments = storage.attachments.listMetadata({
      groupId: groupId as string | undefined,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
    res.json(attachments);
  });

  router.get('/attachments/stats', (_req, res) => {
    res.json(storage.attachments.getStats());
  });

  router.get('/attachments/:id/image', (req, res) => {
    const attachment = storage.attachments.get(req.params.id);
    if (!attachment) {
      res.status(404).json({ error: 'Attachment not found' });
      return;
    }
    res.set('Content-Type', attachment.contentType);
    res.send(attachment.data);
  });

  router.delete('/attachments/:id', (req, res) => {
    const success = storage.attachments.deleteById(req.params.id);
    if (!success) return res.status(404).json({ success: false });
    res.json({ success: true });
  });

  return router;
}
