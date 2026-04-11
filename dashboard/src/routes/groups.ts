import { Router } from 'express';
import type { Storage } from '../../../bot/src/storage';
import type { SignalClient } from '../../../bot/src/signalClient';

export function createGroupRoutes(storage: Storage, signalClient: SignalClient | null): Router {
  const router = Router();

  const signalNotConfigured = { error: 'Signal client not configured — set BOT_PHONE_NUMBER' };

  function enrichGroups(groups: Array<{ id: string; name: string; members: string[] }>) {
    return groups.map((g) => {
      const settings = storage.groupSettings.get(g.id);
      return {
        ...g,
        enabled: settings ? settings.enabled : true,
        activePersona: storage.personas.getActiveForGroup(g.id)?.name ?? 'Default',
        settings,
        messageCount: storage.messages.getCount(g.id),
        lastActivity: storage.messages.getLastTimestamp(g.id),
      };
    });
  }

  router.get('/groups', async (_req, res) => {
    if (!signalClient) return res.status(503).json(signalNotConfigured);
    try {
      const signalGroups = (await signalClient.listGroups()) as Array<{
        id: string;
        name: string;
        members: string[];
      }>;
      res.json(enrichGroups(signalGroups));
    } catch {
      res.status(503).json({ error: 'Could not fetch groups — signal-cli may be unreachable' });
    }
  });

  router.get('/groups/:id', async (req, res) => {
    if (!signalClient) return res.status(503).json(signalNotConfigured);
    try {
      const group = (await signalClient.getGroup(req.params.id)) as Record<string, unknown>;
      const settings = storage.groupSettings.get(req.params.id);
      const activePersona = storage.personas.getActiveForGroup(req.params.id);
      res.json({ ...group, settings, activePersona });
    } catch {
      res.status(503).json({ error: 'Could not fetch group details' });
    }
  });

  router.post('/groups/join', async (req, res) => {
    if (!signalClient) return res.status(503).json(signalNotConfigured);
    const { uri } = req.body;
    if (!uri || typeof uri !== 'string' || !uri.startsWith('https://signal.group/#')) {
      return res.status(400).json({ error: 'Invalid Signal group invite link format' });
    }
    try {
      const beforeGroups = (await signalClient.listGroups()) as Array<{ id: string }>;
      const beforeIds = new Set(beforeGroups.map((g) => g.id));

      await signalClient.joinGroup(uri);

      const signalGroups = (await signalClient.listGroups()) as Array<{
        id: string;
        name: string;
        members: string[];
      }>;

      // Admin-approval groups won't appear in the list yet
      const newGroupFound = signalGroups.some((g) => !beforeIds.has(g.id));
      if (!newGroupFound) {
        return res.status(202).json({ message: 'Join request sent — awaiting admin approval' });
      }

      res.json({ groups: enrichGroups(signalGroups) });
    } catch (err) {
      const message = (err as Error).message || 'Unknown error';
      if (message.includes('Signal RPC error')) {
        return res.status(422).json({ error: message });
      }
      if (message.includes('Signal API error')) {
        return res.status(503).json({ error: 'Signal service unavailable' });
      }
      res.status(500).json({ error: 'Failed to join group' });
    }
  });

  router.post('/groups/:id/leave', async (req, res) => {
    if (!signalClient) return res.status(503).json(signalNotConfigured);
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

      let parsedTriggers = customTriggers;
      if (typeof customTriggers === 'string') {
        parsedTriggers = customTriggers.split(',').map((s: string) => s.trim()).filter((s: string) => s.length > 0);
      }

      if (contextWindowSize !== undefined && contextWindowSize !== null) {
        if (typeof contextWindowSize !== 'number' || !Number.isInteger(contextWindowSize) || contextWindowSize <= 0) {
          return res.status(400).json({ error: 'contextWindowSize must be a positive integer' });
        }
      }

      storage.groupSettings.upsert(req.params.id, {
        enabled,
        customTriggers: parsedTriggers,
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
