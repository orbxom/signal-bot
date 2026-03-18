import { Router } from 'express';
import type { FactoryService } from '../services/factoryService';

export function createFactoryRoutes(factoryService: FactoryService): Router {
  const router = Router();

  router.get('/factory/runs', (_req, res) => {
    res.json(factoryService.getSnapshot());
  });

  return router;
}
