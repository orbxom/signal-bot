import { Router } from 'express';
import type { Storage } from '../../../bot/src/storage';

export function createReminderRoutes(storage: Storage): Router {
  const router = Router();

  router.get('/reminders', (req, res) => {
    const { groupId, status, limit, offset } = req.query;
    const reminders = storage.reminders.listAll({
      groupId: groupId as string | undefined,
      status: status as string | undefined,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
    res.json(reminders);
  });

  router.delete('/reminders/:id', (req, res) => {
    const groupId = req.query.groupId as string;
    if (!groupId) {
      res.status(400).json({ error: 'groupId required' });
      return;
    }
    const success = storage.reminders.cancel(Number(req.params.id), groupId);
    if (!success) return res.status(404).json({ success: false });
    res.json({ success: true });
  });

  router.get('/recurring-reminders', (req, res) => {
    const { groupId, limit, offset } = req.query;
    const reminders = storage.recurringReminders.listAll({
      groupId: groupId as string | undefined,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
    res.json(reminders);
  });

  router.delete('/recurring-reminders/:id', (req, res) => {
    const groupId = req.query.groupId as string;
    if (!groupId) {
      res.status(400).json({ error: 'groupId required' });
      return;
    }
    const success = storage.recurringReminders.cancel(Number(req.params.id), groupId);
    if (!success) return res.status(404).json({ success: false });
    res.json({ success: true });
  });

  router.post('/recurring-reminders/:id/reset-failures', (req, res) => {
    const success = storage.recurringReminders.resetFailures(Number(req.params.id));
    if (!success) return res.status(404).json({ success: false });
    res.json({ success: true });
  });

  return router;
}
