import type { FastifyReply, FastifyRequest } from 'fastify';
import { callerId } from '@core/auth';
import { AdminSecurityService } from './security.service.js';
import {
  forceLogoutBodySchema,
  listLoginHistoryQuerySchema,
  listSecurityEventsQuerySchema,
  listSessionsQuerySchema,
  sessionIdParamSchema,
  updateSecurityPolicyBodySchema,
  type SecurityPolicyDto,
} from './security.schemas.js';

export class AdminSecurityController {
  constructor(private readonly adminSecurityService: AdminSecurityService) {}

  async listSessions(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = listSessionsQuerySchema.parse(req.query);
    reply.send(await this.adminSecurityService.listSessions(query));
  }

  async revokeSession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = sessionIdParamSchema.parse(req.params);
    await this.adminSecurityService.revokeSession(id, callerId(req));
    reply.status(204).send();
  }

  async forceLogoutAll(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const body = forceLogoutBodySchema.parse(req.body ?? {});
    const result = await this.adminSecurityService.forceLogoutAll(callerId(req), body.userId);
    reply.send(result);
  }

  async listLoginHistory(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = listLoginHistoryQuerySchema.parse(req.query);
    reply.send(await this.adminSecurityService.listLoginHistory(query));
  }

  async listEvents(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = listSecurityEventsQuerySchema.parse(req.query);
    reply.send(await this.adminSecurityService.listSecurityEvents(query));
  }

  async getPolicy(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
    reply.send(await this.adminSecurityService.getPolicy());
  }

  async updatePolicy(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const body = updateSecurityPolicyBodySchema.parse(req.body);
    const patch = Object.fromEntries(
      Object.entries(body).filter(([, value]) => value !== undefined),
    ) as Partial<SecurityPolicyDto>;
    reply.send(await this.adminSecurityService.updatePolicy(patch, callerId(req)));
  }
}
