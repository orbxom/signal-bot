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

  router.put('/memories/:id', (req, res) => {
    const id = Number(req.params.id);
    const { title, description, content, type } = req.body;
    const memory = storage.memories.update(id, { title, description, content, type });
    if (!memory) return res.status(404).json({ error: 'Memory not found' });
    res.json(memory);
  });

  router.delete('/memories/:id', (req, res) => {
    const id = Number(req.params.id);
    const success = storage.memories.deleteById(id);
    if (!success) return res.status(404).json({ success: false });
    res.json({ success: true });
  });

  return router;
}
