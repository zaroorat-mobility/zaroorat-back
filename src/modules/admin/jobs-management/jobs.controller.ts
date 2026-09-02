import type { FastifyReply, FastifyRequest } from 'fastify';
import { AdminJobsService } from './jobs.service.js';
import {
  jobActionBodySchema,
  listQueueJobsQuerySchema,
  queueJobParamsSchema,
  queueNameParamSchema,
} from './jobs.schemas.js';

export class AdminJobsController {
  constructor(private readonly adminJobsService: AdminJobsService) {}

  async listQueues(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
    reply.send(await this.adminJobsService.listQueues());
  }

  async listQueueJobs(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { name } = queueNameParamSchema.parse(req.params);
    const query = listQueueJobsQuerySchema.parse(req.query);
    reply.send(await this.adminJobsService.listQueueJobs({ queue: name, ...query }));
  }

  async getJob(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { queue, jobId } = queueJobParamsSchema.parse(req.params);
    reply.send(await this.adminJobsService.getJob(queue, jobId));
  }

  async mutateJob(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { queue, jobId } = queueJobParamsSchema.parse(req.params);
    const { action } = jobActionBodySchema.parse(req.body);
    await this.adminJobsService.mutateJob(queue, jobId, action);
    reply.status(204).send();
  }

  async listSchedulers(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
    reply.send(await this.adminJobsService.listSchedulers());
  }
}
