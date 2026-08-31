import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { container } from '@core/di';
import { errorEnvelope, isCodedError } from '@core/errors/envelope.js';
import { AdminRideController } from './rides/ride.controller.js';
import { AdminLiveController } from './live/live.controller.js';
import { AdminDispatchController } from './dispatch/dispatch.controller.js';
import { AdminTicketController } from './support/ticket.controller.js';
import { AdminSafetyController } from './safety/incident.controller.js';

function handleOperationsError(err: unknown, request: FastifyRequest, reply: FastifyReply): void {
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
  request.log.error({ err }, '[admin-operations] unhandled error');
  reply
    .status(500)
    .send(errorEnvelope('INTERNAL', 'An unexpected operations admin error occurred', request.id));
}

export async function operationsManagementRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.setErrorHandler(handleOperationsError);

  const rideController = container.resolve<AdminRideController>('adminRideController');
  const liveController = container.resolve<AdminLiveController>('adminLiveController');
  const dispatchController = container.resolve<AdminDispatchController>('adminDispatchController');
  const ticketController = container.resolve<AdminTicketController>('adminTicketController');
  const safetyController = container.resolve<AdminSafetyController>('adminSafetyController');

  const canRead = { preHandler: fastify.authorize({ permissions: ['operations:read'] }) };
  const canWrite = { preHandler: fastify.authorize({ permissions: ['operations:write'] }) };

  // Ride Management
  fastify.get('/rides', canRead, (req, reply) => rideController.list(req, reply));
  fastify.get('/rides/export', canRead, (req, reply) => rideController.exportCsv(req, reply));
  fastify.get('/rides/:id', canRead, (req, reply) => rideController.getById(req, reply));
  fastify.get('/rides/:id/timeline', canRead, (req, reply) =>
    rideController.getTimeline(req, reply),
  );
  fastify.get('/rides/:id/fare-breakdown', canRead, (req, reply) =>
    rideController.getFareBreakdown(req, reply),
  );
  fastify.get('/rides/:id/payments', canRead, (req, reply) =>
    rideController.getPayments(req, reply),
  );
  fastify.get('/rides/:id/driver-location', canRead, (req, reply) =>
    rideController.getDriverLocation(req, reply),
  );
  fastify.get('/rides/:id/notes', canRead, (req, reply) => rideController.listNotes(req, reply));
  fastify.post('/rides/:id/notes', canWrite, (req, reply) => rideController.addNote(req, reply));
  fastify.post('/rides/:id/actions/cancel', canWrite, (req, reply) =>
    rideController.cancelRide(req, reply),
  );
  fastify.get('/rides/:id/audit', canRead, (req, reply) => rideController.getAuditLogs(req, reply));

  // Live Operations
  fastify.get('/live/summary', canRead, (req, reply) => liveController.getSummary(req, reply));
  fastify.get('/live/active-rides', canRead, (req, reply) =>
    liveController.getActiveRides(req, reply),
  );
  fastify.get('/live/map', canRead, (req, reply) => liveController.getMap(req, reply));
  fastify.get('/live/drivers', canRead, (req, reply) => liveController.getDrivers(req, reply));
  fastify.get('/live/alerts', canRead, (req, reply) => liveController.getAlerts(req, reply));

  // Dispatch & Matching Console
  fastify.get('/dispatch/requests', canRead, (req, reply) =>
    dispatchController.listRequests(req, reply),
  );
  fastify.get('/dispatch/requests/:id', canRead, (req, reply) =>
    dispatchController.getRequestDetails(req, reply),
  );
  fastify.get('/dispatch/requests/:id/candidates', canRead, (req, reply) =>
    dispatchController.getCandidates(req, reply),
  );

  // Support & Complaints Queue
  fastify.get('/tickets', canRead, (req, reply) => ticketController.list(req, reply));
  fastify.get('/tickets/categories', canRead, (req, reply) =>
    ticketController.listCategories(req, reply),
  );
  fastify.get('/tickets/agents', canRead, (req, reply) => ticketController.listAgents(req, reply));
  fastify.get('/categories', canRead, (req, reply) => ticketController.listCategories(req, reply));
  fastify.get('/tickets/:id', canRead, (req, reply) => ticketController.getById(req, reply));
  fastify.post('/tickets', canWrite, (req, reply) => ticketController.create(req, reply));
  fastify.post('/tickets/:id/assign', canWrite, (req, reply) =>
    ticketController.assign(req, reply),
  );
  fastify.patch('/tickets/:id/status', canWrite, (req, reply) =>
    ticketController.updateStatus(req, reply),
  );
  fastify.post('/tickets/:id/messages', canWrite, (req, reply) =>
    ticketController.addMessage(req, reply),
  );
  fastify.post('/tickets/:id/resolve', canWrite, (req, reply) =>
    ticketController.resolve(req, reply),
  );

  // Safety & Incident Management (Safety Center)
  fastify.get('/incidents', canRead, (req, reply) => safetyController.list(req, reply));
  fastify.get('/incidents/:id', canRead, (req, reply) => safetyController.getById(req, reply));
  fastify.post('/incidents', canWrite, (req, reply) => safetyController.create(req, reply));
  fastify.post('/incidents/:id/acknowledge', canWrite, (req, reply) =>
    safetyController.acknowledge(req, reply),
  );
  fastify.post('/incidents/:id/resolve', canWrite, (req, reply) =>
    safetyController.resolve(req, reply),
  );
  fastify.post('/incidents/:id/escalate', canWrite, (req, reply) =>
    safetyController.escalate(req, reply),
  );
  fastify.post('/incidents/:id/notes', canWrite, (req, reply) =>
    safetyController.addNote(req, reply),
  );
  fastify.post('/incidents/:id/evidence', canWrite, (req, reply) =>
    safetyController.attachEvidence(req, reply),
  );
}
