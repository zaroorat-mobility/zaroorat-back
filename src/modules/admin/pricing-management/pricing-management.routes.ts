import type { FastifyInstance } from 'fastify';
import { container } from '@core/di';
import { AdminSurgeController } from './surge.controller.js';

const uuidParams = {
  type: 'object',
  required: ['id'],
  properties: {
    id: {
      type: 'string',
      pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
    },
  },
} as const;

export async function adminSurgeRoutes(fastify: FastifyInstance): Promise<void> {
  const adminSurgeController = container.resolve<AdminSurgeController>('adminSurgeController');

  // Surge Zones
  fastify.post('/surge-zones', {
    schema: {
      tags: ['Admin', 'Surge'],
      summary: 'Create a new Surge Zone',
    },
    handler: adminSurgeController.createSurgeZone.bind(adminSurgeController),
  });

  fastify.get('/surge-zones', {
    schema: {
      tags: ['Admin', 'Surge'],
      summary: 'List Surge Zones',
    },
    handler: adminSurgeController.listSurgeZones.bind(adminSurgeController),
  });

  fastify.get('/surge-zones/:id', {
    schema: {
      tags: ['Admin', 'Surge'],
      summary: 'Get Surge Zone by ID',
      params: uuidParams,
    },
    handler: adminSurgeController.getSurgeZone.bind(adminSurgeController),
  });

  fastify.patch('/surge-zones/:id', {
    schema: {
      tags: ['Admin', 'Surge'],
      summary: 'Update Surge Zone',
      params: uuidParams,
    },
    handler: adminSurgeController.updateSurgeZone.bind(adminSurgeController),
  });

  fastify.delete('/surge-zones/:id', {
    schema: {
      tags: ['Admin', 'Surge'],
      summary: 'Deactivate Surge Zone',
      params: uuidParams,
    },
    handler: adminSurgeController.deleteSurgeZone.bind(adminSurgeController),
  });

  // Surge Windows
  fastify.post('/surge-windows', {
    schema: {
      tags: ['Admin', 'Surge'],
      summary: 'Create a new Surge Window',
    },
    handler: adminSurgeController.createSurgeWindow.bind(adminSurgeController),
  });

  fastify.get('/surge-windows', {
    schema: {
      tags: ['Admin', 'Surge'],
      summary: 'List Surge Windows',
    },
    handler: adminSurgeController.listSurgeWindows.bind(adminSurgeController),
  });

  fastify.get('/surge-windows/:id', {
    schema: {
      tags: ['Admin', 'Surge'],
      summary: 'Get Surge Window by ID',
      params: uuidParams,
    },
    handler: adminSurgeController.getSurgeWindow.bind(adminSurgeController),
  });

  fastify.patch('/surge-windows/:id', {
    schema: {
      tags: ['Admin', 'Surge'],
      summary: 'Update Surge Window',
      params: uuidParams,
    },
    handler: adminSurgeController.updateSurgeWindow.bind(adminSurgeController),
  });

  fastify.delete('/surge-windows/:id', {
    schema: {
      tags: ['Admin', 'Surge'],
      summary: 'Deactivate Surge Window',
      params: uuidParams,
    },
    handler: adminSurgeController.deleteSurgeWindow.bind(adminSurgeController),
  });
}
