import type { FastifyInstance } from 'fastify';
import { container } from '@core/di';
import { AdminJobsController } from './jobs.controller.js';

export async function jobsManagementRoutes(fastify: FastifyInstance): Promise<void> {
  const controller = container.resolve<AdminJobsController>('adminJobsController');
  const canRead = { preHandler: fastify.authorize({ permissions: ['jobs:read'] }) };
  const canWrite = { preHandler: fastify.authorize({ permissions: ['jobs:write'] }) };

  fastify.get('/queues', canRead, (req, reply) => controller.listQueues(req, reply));
  fastify.get('/queues/:name/jobs', canRead, (req, reply) => controller.listQueueJobs(req, reply));
  fastify.get('/schedulers', canRead, (req, reply) => controller.listSchedulers(req, reply));
  fastify.get('/:queue/:jobId', canRead, (req, reply) => controller.getJob(req, reply));
  fastify.post('/:queue/:jobId', canWrite, (req, reply) => controller.mutateJob(req, reply));
}
