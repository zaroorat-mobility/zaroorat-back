import type { FastifyReply, FastifyRequest } from 'fastify';
import { callerId } from '@core/auth';
import { AdminMonitoringService } from './monitoring.service.js';
import { ackAlertParamsSchema, listErrorsQuerySchema } from './monitoring.schemas.js';

export class AdminMonitoringController {
  constructor(private readonly adminMonitoringService: AdminMonitoringService) {}

  async getHealth(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
    reply.send(await this.adminMonitoringService.getHealth());
  }

  async getPerformance(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
    reply.send(await this.adminMonitoringService.getPerformance());
  }

  async getErrors(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = listErrorsQuerySchema.parse(req.query);
    reply.send(await this.adminMonitoringService.getErrors(query.limit));
  }

  async getAlerts(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
    reply.send(await this.adminMonitoringService.getAlerts());
  }

  async ackAlert(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = ackAlertParamsSchema.parse(req.params);
    await this.adminMonitoringService.ackAlert(id, callerId(req));
    reply.status(204).send();
  }
}
