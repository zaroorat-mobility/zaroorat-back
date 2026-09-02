import type { FastifyReply, FastifyRequest } from 'fastify';
import { AdminDashboardService } from './dashboard.service.js';

export class AdminDashboardController {
  constructor(private readonly adminDashboardService: AdminDashboardService) {}

  async getStats(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const stats = await this.adminDashboardService.getStats();
    reply.send(stats);
  }
}
