import { sessionConfig } from '@config/session/session.config.js';
import { DatabaseService } from '@core/database';
import { TransactionManager } from '@core/database/TransactionManager';
import { SessionService } from '@modules/auth/services/session/session.service.js';
import { isStaffRoleSlug, STAFF_ROLE_SLUGS } from '@modules/auth/constants/auth.constants.js';
import { SystemSettingService } from '../system-settings/services/system-setting.service.js';
import { recordAdminAction } from '../audit/index.js';
import type { AuditAction } from '../../../generated/prisma/index.js';
import { AdminSessionNotFoundError } from './security.errors.js';
import type { SecurityPolicyDto } from './security.schemas.js';

const SECURITY_POLICY_KEY = 'security.policy';
const SECURITY_POLICY_CATEGORY = 'security';

const DEFAULT_POLICY: SecurityPolicyDto = Object.freeze({
  sessionMaxConcurrent: sessionConfig.privilegedMaxConcurrentSessions,
  sessionTtlHours: 168,
  requireMfa: false,
  ipAllowlistEnabled: false,
  passwordMinLength: 12,
});

export interface AdminSessionDto {
  id: string;
  userId: string;
  userEmail: string | null;
  userPhone: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  mfaVerified: boolean;
  startedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  active: boolean;
}

export interface LoginHistoryDto {
  id: string;
  userId: string;
  userEmail: string | null;
  loginMethod: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  revokedAt: string | null;
  active: boolean;
}

export interface SecurityEventDto {
  id: string;
  actorId: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  summary: string | null;
  ipAddress: string | null;
  createdAt: string;
}

export class AdminSecurityService {
  constructor(
    private readonly db: DatabaseService,
    private readonly sessionService: SessionService,
    private readonly systemSettingService: SystemSettingService,
    private readonly transactionManager: TransactionManager,
  ) {}

  private get client() {
    return this.db.client;
  }

  async listSessions(input: {
    page: number;
    limit: number;
    userId?: string | undefined;
    activeOnly?: boolean | undefined;
  }): Promise<{ data: AdminSessionDto[]; meta: { page: number; limit: number; total: number } }> {
    const now = new Date();
    const where = {
      ...(input.userId ? { userId: input.userId } : {}),
      ...(input.activeOnly ? { revokedAt: null, expiresAt: { gt: now } } : {}),
    };

    const [rows, total] = await Promise.all([
      this.client.adminSession.findMany({
        where,
        orderBy: { startedAt: 'desc' },
        skip: (input.page - 1) * input.limit,
        take: input.limit,
        include: {
          user: { select: { email: true, phoneNumber: true } },
        },
      }),
      this.client.adminSession.count({ where }),
    ]);

    return {
      data: rows.map((row) => ({
        id: row.id,
        userId: row.userId,
        userEmail: row.user.email,
        userPhone: row.user.phoneNumber,
        ipAddress: row.ipAddress,
        userAgent: row.userAgent,
        mfaVerified: row.mfaVerified,
        startedAt: row.startedAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
        revokedAt: row.revokedAt?.toISOString() ?? null,
        active: row.revokedAt === null && row.expiresAt > now,
      })),
      meta: { page: input.page, limit: input.limit, total },
    };
  }

  async revokeSession(sessionId: string, actorId: string): Promise<void> {
    const adminSession = await this.client.adminSession.findUnique({ where: { id: sessionId } });
    if (!adminSession) throw new AdminSessionNotFoundError();

    const userSession = await this.client.userSession.findFirst({
      where: {
        userId: adminSession.userId,
        loginMethod: { startsWith: 'admin_' },
        createdAt: {
          gte: new Date(adminSession.startedAt.getTime() - 5000),
          lte: new Date(adminSession.startedAt.getTime() + 5000),
        },
        revokedAt: null,
      },
      orderBy: { createdAt: 'desc' },
    });

    await this.transactionManager.execute(async (tx) => {
      if (!adminSession.revokedAt) {
        await tx.adminSession.update({
          where: { id: sessionId },
          data: { revokedAt: new Date() },
        });
      }

      await recordAdminAction(tx, {
        actorId,
        action: 'LOGOUT',
        entityType: 'admin_session',
        entityId: sessionId,
        summary: 'Admin session revoked',
      });
    });

    if (userSession) {
      await this.sessionService.revokeForUser(adminSession.userId, userSession.id);
    }
  }

  async forceLogoutAll(actorId: string, userId?: string): Promise<{ revokedCount: number }> {
    const now = new Date();
    const staffUsers = userId
      ? [{ id: userId }]
      : await this.client.user.findMany({
          where: {
            deletedAt: null,
            roleAssignments: {
              some: {
                revokedAt: null,
                OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
                role: { slug: { in: [...STAFF_ROLE_SLUGS] } },
              },
            },
          },
          select: { id: true },
        });

    let revokedCount = 0;
    for (const user of staffUsers) {
      const roles = await this.client.userRoleAssignment.findMany({
        where: {
          userId: user.id,
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        include: { role: { select: { slug: true } } },
      });
      const isStaff = roles.some((r) => isStaffRoleSlug(r.role.slug));
      if (!isStaff) continue;

      await this.sessionService.logoutAll(user.id, 'admin_force_logout');
      const result = await this.client.adminSession.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: now },
      });
      revokedCount += result.count;
    }

    await recordAdminAction(this.client, {
      actorId,
      action: 'LOGOUT',
      entityType: 'admin_session',
      summary: userId
        ? `Force logout for user ${userId} (${revokedCount} sessions)`
        : `Force logout for all admin users (${revokedCount} sessions)`,
    });

    return { revokedCount };
  }

  async listLoginHistory(input: {
    page: number;
    limit: number;
    userId?: string | undefined;
  }): Promise<{ data: LoginHistoryDto[]; meta: { page: number; limit: number; total: number } }> {
    const where = {
      loginMethod: { startsWith: 'admin_' },
      ...(input.userId ? { userId: input.userId } : {}),
    };

    const [rows, total] = await Promise.all([
      this.client.userSession.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (input.page - 1) * input.limit,
        take: input.limit,
        include: { user: { select: { email: true } } },
      }),
      this.client.userSession.count({ where }),
    ]);

    const now = new Date();
    return {
      data: rows.map((row) => ({
        id: row.id,
        userId: row.userId,
        userEmail: row.user.email,
        loginMethod: row.loginMethod,
        ipAddress: row.ipAddress,
        userAgent: row.userAgent,
        createdAt: row.createdAt.toISOString(),
        revokedAt: row.revokedAt?.toISOString() ?? null,
        active: row.revokedAt === null && row.expiresAt > now,
      })),
      meta: { page: input.page, limit: input.limit, total },
    };
  }

  async listSecurityEvents(input: {
    page: number;
    limit: number;
    action?: AuditAction | undefined;
  }): Promise<{ data: SecurityEventDto[]; meta: { page: number; limit: number; total: number } }> {
    const where = input.action
      ? { action: input.action }
      : {
          OR: [
            { action: { in: ['LOGIN', 'LOGOUT'] as AuditAction[] } },
            { entityType: { in: ['admin_session', 'security_policy', 'user_session'] } },
          ],
        };

    const [rows, total] = await Promise.all([
      this.client.adminActivityLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (input.page - 1) * input.limit,
        take: input.limit,
      }),
      this.client.adminActivityLog.count({ where }),
    ]);

    return {
      data: rows.map((row) => ({
        id: row.id,
        actorId: row.actorId,
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        summary: row.summary,
        ipAddress: row.ipAddress,
        createdAt: row.createdAt.toISOString(),
      })),
      meta: { page: input.page, limit: input.limit, total },
    };
  }

  async getPolicy(): Promise<SecurityPolicyDto> {
    const raw = await this.systemSettingService.getSettingValue(SECURITY_POLICY_KEY);
    if (!raw) return { ...DEFAULT_POLICY };
    try {
      const parsed = JSON.parse(raw) as Partial<SecurityPolicyDto>;
      return { ...DEFAULT_POLICY, ...parsed };
    } catch {
      return { ...DEFAULT_POLICY };
    }
  }

  async updatePolicy(
    input: Partial<SecurityPolicyDto>,
    actorId: string,
  ): Promise<SecurityPolicyDto> {
    const patch = Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined),
    ) as Partial<SecurityPolicyDto>;
    const before = await this.getPolicy();
    const after = { ...before, ...patch };

    await this.transactionManager.execute(async (tx) => {
      await this.systemSettingService.setSetting(
        {
          key: SECURITY_POLICY_KEY,
          value: JSON.stringify(after),
          category: SECURITY_POLICY_CATEGORY,
          description: 'Admin security policy',
        },
        tx,
      );
      await recordAdminAction(tx, {
        actorId,
        action: 'UPDATE',
        entityType: 'security_policy',
        summary: 'Security policy updated',
        before,
        after,
      });
    });

    return after;
  }
}
