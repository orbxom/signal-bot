import { Router } from 'express';
import type { Storage } from '../../../bot/src/storage';

export function createMessageRoutes(storage: Storage): Router {
  const router = Router();

  router.get('/messages', (req, res) => {
    const { groupId, search, from, to, limit } = req.query;
    if (!groupId) {
      res.status(400).json({ error: 'groupId required' });
      return;
    }

    const startTs = from ? Number(from) : 0;
    const endTs = to ? Number(to) : Number.MAX_SAFE_INTEGER;
    const lim = Math.min(Number(limit) || 50, 200);

    if (search) {
      const messages = storage.messages.search(groupId as string, search as string, {
        startTimestamp: startTs,
        endTimestamp: endTs,
        limit: lim,
      });
      res.json(messages);
    } else {
      const messages = storage.messages.getByDateRange(groupId as string, startTs, endTs, lim);
      res.json(messages);
    }
  });

  return router;
}
