import type { FastifyReply, FastifyRequest } from 'fastify';
import { AdminAuditService } from './audit.service.js';
import { listAuditLogsQuerySchema } from './audit.schemas.js';

export class AdminAuditController {
  constructor(private readonly adminAuditService: AdminAuditService) {}

  async listLogs(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = listAuditLogsQuerySchema.parse(req.query);
    reply.send(await this.adminAuditService.listLogs(query));
  }
}
