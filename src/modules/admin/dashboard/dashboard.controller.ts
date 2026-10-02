import type { FastifyReply, FastifyRequest } from 'fastify';
import type { PermissionRepository } from '@modules/auth/repositories/permission.repository.js';
import { SYSTEM_ADMIN_ROLE_SLUG } from '@modules/auth/constants/auth.constants.js';
import { AdminDashboardService } from './dashboard.service.js';
import {
  activityQuerySchema,
  financialAnalyticsQuerySchema,
  liveDriversQuerySchema,
} from './dashboard.schemas.js';

/** Query parsing throws ZodError on invalid input; dashboard.routes.ts answers it with 400. */
export class AdminDashboardController {
  constructor(
    private readonly adminDashboardService: AdminDashboardService,
    private readonly permissionRepository: PermissionRepository,
  ) {}

  async getOverview(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
    reply.send(await this.adminDashboardService.getOverview());
  }

  async getFinancials(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
    reply.send(await this.adminDashboardService.getFinancials());
  }

  async getStats(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
    reply.send(await this.adminDashboardService.getStats());
  }

  async getAnalytics(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
    reply.send(await this.adminDashboardService.getAnalytics());
  }

  async getFinancialAnalytics(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { range } = financialAnalyticsQuerySchema.parse(req.query);
    reply.send(await this.adminDashboardService.getFinancialAnalytics(range));
  }

  async getLiveDrivers(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    reply.send(
      await this.adminDashboardService.getLiveDrivers(liveDriversQuerySchema.parse(req.query)),
    );
  }

  async getActivity(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = activityQuerySchema.parse(req.query);
    const includeAdminActions = await this.canReadAudit(req);
    reply.send(await this.adminDashboardService.getActivity(query, { includeAdminActions }));
  }

  async getHealth(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
    reply.send(await this.adminDashboardService.getHealth());
  }

  /** Admin actions are audit data: shown only to callers who may read the audit log. */
  private async canReadAudit(req: FastifyRequest): Promise<boolean> {
    const auth = req.auth;
    if (!auth) return false;
    if (auth.roles.includes(SYSTEM_ADMIN_ROLE_SLUG)) return true;
    const held = await this.permissionRepository.findAllowedCodesForUser(auth.userId);
    return held.includes('audit:read');
  }
}
