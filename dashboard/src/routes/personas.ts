import { Router } from 'express';
import type { Storage } from '../../../bot/src/storage';

export function createPersonaRoutes(storage: Storage): Router {
  const router = Router();

  router.get('/personas', (_req, res) => {
    res.json(storage.personas.list());
  });

  router.post('/personas', (req, res) => {
    const { name, description, tags } = req.body;
    try {
      const persona = storage.personas.create(name, description, tags);
      res.status(201).json(persona);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.put('/personas/:id', (req, res) => {
    const { name, description, tags } = req.body;
    const success = storage.personas.update(Number(req.params.id), name, description, tags);
    res.json({ success });
  });

  router.delete('/personas/:id', (req, res) => {
    const success = storage.personas.delete(Number(req.params.id));
    res.json({ success });
  });

  router.post('/groups/:groupId/persona', (req, res) => {
    const { personaId } = req.body;
    storage.personas.setActive(req.params.groupId, personaId);
    res.json({ success: true });
  });

  return router;
}
