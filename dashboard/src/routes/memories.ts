import { Router } from 'express';
import type { Storage } from '../../../bot/src/storage';

export function createMemoryRoutes(storage: Storage): Router {
  const router = Router();

  router.get('/memories', (req, res) => {
    const { groupId, limit, offset } = req.query;
    const memories = storage.memories.listAll({
      groupId: groupId as string | undefined,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
    res.json(memories);
  });

  router.put('/memories/:groupId/:topic', (req, res) => {
    const { content } = req.body;
    try {
      const memory = storage.memories.upsert(req.params.groupId, req.params.topic, content);
      res.json(memory);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.delete('/memories/:groupId/:topic', (req, res) => {
    const success = storage.memories.delete(req.params.groupId, req.params.topic);
    if (!success) return res.status(404).json({ success: false });
    res.json({ success: true });
  });

  return router;
}
