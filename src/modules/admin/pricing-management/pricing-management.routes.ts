import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { container } from '@core/di';
import { errorEnvelope, isCodedError } from '@core/errors/envelope.js';
import { AdminSurgeController } from './surge/surge.controller.js';
import { AdminFareController } from './fare/fare.controller.js';
import { AdminCancellationController } from './cancellation/cancellation.controller.js';
import { AdminServiceZoneController } from './service-zone/service-zone.controller.js';
import { AdminInvoiceController } from './invoice/invoice.controller.js';

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

function handlePricingError(err: unknown, request: FastifyRequest, reply: FastifyReply): void {
  if (err instanceof ZodError) {
    reply.status(400).send(
      errorEnvelope('VALIDATION', 'Request validation failed', request.id, {
        details: err.issues,
      }),
    );
    return;
  }
  if (isCodedError(err) && err.statusCode < 500) {
    reply.status(err.statusCode).send(errorEnvelope(err.code, err.message, request.id));
    return;
  }
  request.log.error({ err }, '[admin-pricing] unhandled error');
  reply
    .status(500)
    .send(errorEnvelope('INTERNAL', 'An unexpected pricing admin error occurred', request.id));
}

export async function adminSurgeRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.setErrorHandler(handlePricingError);

  const adminSurgeController = container.resolve<AdminSurgeController>('adminSurgeController');
  const adminFareController = container.resolve<AdminFareController>('adminFareController');
  const adminCancellationController = container.resolve<AdminCancellationController>(
    'adminCancellationController',
  );
  const adminServiceZoneController = container.resolve<AdminServiceZoneController>(
    'adminServiceZoneController',
  );
  const adminInvoiceController =
    container.resolve<AdminInvoiceController>('adminInvoiceController');
  const canRead = { preHandler: fastify.authorize({ permissions: ['pricing:read'] }) };
  const canWrite = { preHandler: fastify.authorize({ permissions: ['pricing:write'] }) };

  // Service zones (for fare rule scoping)
  fastify.get('/service-zones', canRead, (req, reply) =>
    adminServiceZoneController.list(req, reply),
  );

  // Fare rules
  fastify.get('/fare-rules', canRead, (req, reply) => adminFareController.list(req, reply));
  fastify.get('/fare-rules/:id', canRead, (req, reply) => adminFareController.getById(req, reply));
  fastify.post('/fare-rules', canWrite, (req, reply) => adminFareController.create(req, reply));
  fastify.patch('/fare-rules/:id', canWrite, (req, reply) =>
    adminFareController.update(req, reply),
  );
  fastify.post('/fare-rules/:id/activate', canWrite, (req, reply) =>
    adminFareController.activate(req, reply),
  );
  fastify.post('/fare-rules/:id/deactivate', canWrite, (req, reply) =>
    adminFareController.deactivate(req, reply),
  );
  fastify.delete('/fare-rules/:id', canWrite, (req, reply) =>
    adminFareController.remove(req, reply),
  );

  // Cancellation policies
  fastify.get('/cancellation-policies', canRead, (req, reply) =>
    adminCancellationController.list(req, reply),
  );
  fastify.get('/cancellation-policies/:id', canRead, (req, reply) =>
    adminCancellationController.getById(req, reply),
  );
  fastify.post('/cancellation-policies', canWrite, (req, reply) =>
    adminCancellationController.create(req, reply),
  );
  fastify.patch('/cancellation-policies/:id', canWrite, (req, reply) =>
    adminCancellationController.update(req, reply),
  );
  fastify.post('/cancellation-policies/:id/activate', canWrite, (req, reply) =>
    adminCancellationController.activate(req, reply),
  );
  fastify.post('/cancellation-policies/:id/deactivate', canWrite, (req, reply) =>
    adminCancellationController.deactivate(req, reply),
  );
  fastify.delete('/cancellation-policies/:id', canWrite, (req, reply) =>
    adminCancellationController.remove(req, reply),
  );

  // Surge Zones
  fastify.post('/surge-zones', {
    ...canWrite,
    schema: {
      tags: ['Admin', 'Surge'],
      summary: 'Create a new Surge Zone',
    },
    handler: adminSurgeController.createSurgeZone.bind(adminSurgeController),
  });

  fastify.get('/surge-zones', {
    ...canRead,
    schema: {
      tags: ['Admin', 'Surge'],
      summary: 'List Surge Zones',
    },
    handler: adminSurgeController.listSurgeZones.bind(adminSurgeController),
  });

  fastify.get('/surge-zones/:id', {
    ...canRead,
    schema: {
      tags: ['Admin', 'Surge'],
      summary: 'Get Surge Zone by ID',
      params: uuidParams,
    },
    handler: adminSurgeController.getSurgeZone.bind(adminSurgeController),
  });

  fastify.patch('/surge-zones/:id', {
    ...canWrite,
    schema: {
      tags: ['Admin', 'Surge'],
      summary: 'Update Surge Zone',
      params: uuidParams,
    },
    handler: adminSurgeController.updateSurgeZone.bind(adminSurgeController),
  });

  fastify.delete('/surge-zones/:id', {
    ...canWrite,
    schema: {
      tags: ['Admin', 'Surge'],
      summary: 'Deactivate Surge Zone',
      params: uuidParams,
    },
    handler: adminSurgeController.deleteSurgeZone.bind(adminSurgeController),
  });

  // Surge Windows
  fastify.post('/surge-windows', {
    ...canWrite,
    schema: {
      tags: ['Admin', 'Surge'],
      summary: 'Create a new Surge Window',
    },
    handler: adminSurgeController.createSurgeWindow.bind(adminSurgeController),
  });

  fastify.get('/surge-windows', {
    ...canRead,
    schema: {
      tags: ['Admin', 'Surge'],
      summary: 'List Surge Windows',
    },
    handler: adminSurgeController.listSurgeWindows.bind(adminSurgeController),
  });

  fastify.get('/surge-windows/:id', {
    ...canRead,
    schema: {
      tags: ['Admin', 'Surge'],
      summary: 'Get Surge Window by ID',
      params: uuidParams,
    },
    handler: adminSurgeController.getSurgeWindow.bind(adminSurgeController),
  });

  fastify.patch('/surge-windows/:id', {
    ...canWrite,
    schema: {
      tags: ['Admin', 'Surge'],
      summary: 'Update Surge Window',
      params: uuidParams,
    },
    handler: adminSurgeController.updateSurgeWindow.bind(adminSurgeController),
  });

  fastify.delete('/surge-windows/:id', {
    ...canWrite,
    schema: {
      tags: ['Admin', 'Surge'],
      summary: 'Deactivate Surge Window',
      params: uuidParams,
    },
    handler: adminSurgeController.deleteSurgeWindow.bind(adminSurgeController),
  });

  // Billing invoices
  fastify.get('/invoices', canRead, (req, reply) =>
    adminInvoiceController.listInvoices(req, reply),
  );
  fastify.get('/invoices/:id', canRead, (req, reply) =>
    adminInvoiceController.getInvoiceById(req, reply),
  );

  // Invoice templates
  fastify.get('/invoice-templates', canRead, (req, reply) =>
    adminInvoiceController.listTemplates(req, reply),
  );
  fastify.post('/invoice-templates', canWrite, (req, reply) =>
    adminInvoiceController.createTemplate(req, reply),
  );
  fastify.patch('/invoice-templates/:id', canWrite, (req, reply) =>
    adminInvoiceController.updateTemplate(req, reply),
  );
  fastify.delete('/invoice-templates/:id', canWrite, (req, reply) =>
    adminInvoiceController.deleteTemplate(req, reply),
  );
  fastify.post('/invoice-templates/:id/set-default', canWrite, (req, reply) =>
    adminInvoiceController.setDefaultTemplate(req, reply),
  );
}
