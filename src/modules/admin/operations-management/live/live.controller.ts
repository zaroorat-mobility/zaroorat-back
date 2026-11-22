import { FastifyReply, FastifyRequest } from 'fastify';
import { AdminLiveService } from './live.service.js';
import {
  activeRidesQuerySchema,
  liveAlertsQuerySchema,
  liveDriversQuerySchema,
  liveMapQuerySchema,
  liveSummaryQuerySchema,
} from './live.schemas.js';

export class AdminLiveController {
  constructor(private readonly adminLiveService: AdminLiveService) {}

  async getSummary(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = liveSummaryQuerySchema.parse(req.query);
    const summary = await this.adminLiveService.getSummary(query);
    reply.send(summary);
  }

  async getActiveRides(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = activeRidesQuerySchema.parse(req.query);
    const result = await this.adminLiveService.getActiveRides(query);
    reply.send(result);
  }

  async getMap(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = liveMapQuerySchema.parse(req.query);
    const result = await this.adminLiveService.getMap(query);
    reply.send(result);
  }

  async getDrivers(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = liveDriversQuerySchema.parse(req.query);
    const result = await this.adminLiveService.getDrivers(query);
    reply.send(result);
  }

  async getAlerts(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = liveAlertsQuerySchema.parse(req.query);
    const alerts = await this.adminLiveService.getAlerts(query);
    reply.send(alerts);
  }
}
