import type { FastifyInstance } from 'fastify';

import { container } from '@core/di';
import { FileService } from '../file.service.js';
import { FileController } from './file.controller.js';

/**
 * Registers the FILES API routes (files doc 02) under the caller-provided
 * prefix (mount at `/api/v1/files`).
 *
 * **No route declares `config: { public: true }`.** AUTH's global
 * deny-by-default gate authenticates every matched route, so every path here is
 * protected by construction — a private bucket behind a public API is not a
 * private bucket (doc 02 §3).
 *
 * No `requireUntamperedDevice`: that guard exists for actions which move an
 * identity, and applying it here would lock a legitimate driver with a modded
 * handset out of onboarding entirely. No role guard either — authorization in
 * this module is **relational**, decided from the caller's relationship to a
 * specific file, which a route-level check cannot see.
 *
 * All five endpoints in doc 02 §1. There is no replace endpoint and no list
 * endpoint: replacement is upload + attach + supersede, and the middle step
 * belongs to the owning module (FLOW §5A).
 * @param app The Fastify instance (already carrying the deny-by-default gate).
 */
export async function registerFileRoutes(app: FastifyInstance): Promise<void> {
  const controller = new FileController(container.resolve<FileService>('fileService'));

  app.post('/', controller.createUpload);
  app.post('/:id/complete', controller.completeUpload);
  app.get('/:id', controller.getMetadata);
  app.get('/:id/url', controller.getReadUrl);
  app.delete('/:id', controller.remove);
}
