import { Router } from 'express';
import type { Storage } from '../../../bot/src/storage';
import type { SignalClient } from '../../../bot/src/signalClient';

export function createGroupRoutes(storage: Storage, signalClient: SignalClient): Router {
  const router = Router();

  router.get('/groups', async (_req, res) => {
    try {
      const signalGroups = (await signalClient.listGroups()) as Array<{
        id: string;
        name: string;
        members: string[];
      }>;
      const enriched = signalGroups.map((g) => {
        const settings = storage.groupSettings.get(g.id);
        return {
          ...g,
          enabled: settings ? settings.enabled : true,
          activePersona: storage.personas.getActiveForGroup(g.id)?.name ?? 'Default',
          settings,
        };
      });
      res.json(enriched);
    } catch {
      res.status(503).json({ error: 'Could not fetch groups — signal-cli may be unreachable' });
    }
  });

  router.get('/groups/:id', async (req, res) => {
    try {
      const group = (await signalClient.getGroup(req.params.id)) as Record<string, unknown>;
      const settings = storage.groupSettings.get(req.params.id);
      const activePersona = storage.personas.getActiveForGroup(req.params.id);
      res.json({ ...group, settings, activePersona });
    } catch {
      res.status(503).json({ error: 'Could not fetch group details' });
    }
  });

  router.post('/groups/:id/leave', async (req, res) => {
    try {
      await signalClient.quitGroup(req.params.id);
      storage.groupSettings.upsert(req.params.id, { enabled: false });
      res.json({ success: true });
    } catch {
      res.status(500).json({ error: 'Failed to leave group' });
    }
  });

  router.patch('/groups/:id/settings', (req, res) => {
    try {
      const { enabled, customTriggers, contextWindowSize, toolNotifications } = req.body;
      storage.groupSettings.upsert(req.params.id, {
        enabled,
        customTriggers,
        contextWindowSize,
        toolNotifications,
      });
      res.json(storage.groupSettings.get(req.params.id));
    } catch {
      res.status(500).json({ error: 'Failed to update settings' });
    }
  });

  return router;
}
