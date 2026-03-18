import { Router } from 'express';
import type { Storage } from '../../../bot/src/storage';

export function createDossierRoutes(storage: Storage): Router {
  const router = Router();

  router.get('/dossiers', (req, res) => {
    const { groupId, limit, offset } = req.query;
    const dossiers = storage.dossiers.listAll({
      groupId: groupId as string | undefined,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
    res.json(dossiers);
  });

  router.get('/dossiers/:groupId/:personId', (req, res) => {
    const dossier = storage.dossiers.get(req.params.groupId, req.params.personId);
    if (!dossier) {
      res.status(404).json({ error: 'Dossier not found' });
      return;
    }
    res.json(dossier);
  });

  router.put('/dossiers/:groupId/:personId', (req, res) => {
    const { displayName, notes } = req.body;
    const dossier = storage.dossiers.upsert(req.params.groupId, req.params.personId, displayName, notes);
    res.json(dossier);
  });

  router.delete('/dossiers/:groupId/:personId', (req, res) => {
    const success = storage.dossiers.delete(req.params.groupId, req.params.personId);
    res.json({ success });
  });

  return router;
}
