import { Router } from 'express';
import type { HealthService } from '../services/healthService';
import type { Storage } from '../../../bot/src/storage';

export function createHealthRoutes(healthService: HealthService, storage: Storage): Router {
  const router = Router();

  router.get('/health', async (_req, res) => {
    try {
      const health = await healthService.getHealth();
      res.json(health);
    } catch {
      res.status(500).json({ error: 'Health check failed' });
    }
  });

  router.get('/stats', (_req, res) => {
    try {
      const groups = storage.messages.getDistinctGroupIds();
      const reminderCount = storage.reminders.listAll().length;
      const attachmentStats = storage.attachments.getStats();
      res.json({
        groupCount: groups.length,
        reminderCount,
        attachmentCount: attachmentStats.countByGroup.reduce((sum, g) => sum + g.count, 0),
        attachmentSize: attachmentStats.totalSize,
      });
    } catch {
      res.status(500).json({ error: 'Stats fetch failed' });
    }
  });

  return router;
}
