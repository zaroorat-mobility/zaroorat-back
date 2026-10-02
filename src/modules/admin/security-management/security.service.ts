import { sessionConfig } from '@config/session/session.config.js';
import { DatabaseService } from '@core/database';
import { TransactionManager, type TransactionClient } from '@core/database/TransactionManager';
import { EventPublisher } from '@core/events';
import { SessionService } from '@modules/auth/services/session/session.service.js';
import { authEvent } from '@modules/auth/events/catalog.js';
import { isStaffRoleSlug, STAFF_ROLE_SLUGS } from '@modules/auth/constants/auth.constants.js';
import { SystemSettingService } from '../system-settings/services/system-setting.service.js';
import type { EpochService } from '@modules/auth/services/token/epoch.service.js';
import { logger } from '@shared/logger/index.js';
import {
  lockForAudit,
  lockForAuditKey,
  recordAdminAction,
  type AuditActor,
} from '../audit/index.js';
import type { AuditAction } from '../../../generated/prisma/index.js';
import { AdminSessionNotFoundError, ForceLogoutIncompleteError } from './security.errors.js';
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

export interface ForceLogoutResult {
  revokedCount: number;
  accountsLoggedOut: number;
  /// PENDING: every account was logged out and audited, but some post-commit epoch bumps
  /// failed. Their committed outbox events complete them when relayed.
  cacheInvalidation: 'COMPLETE' | 'PENDING';
  cacheInvalidationPending: string[];
}

export class AdminSecurityService {
  constructor(
    private readonly db: DatabaseService,
    private readonly sessionService: SessionService,
    private readonly systemSettingService: SystemSettingService,
    private readonly transactionManager: TransactionManager,
    private readonly epochService: EpochService,
    private readonly eventPublisher: EventPublisher,
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

  /// The admin session, its paired user session (with that session's refresh tokens) and
  /// the audit row commit together; only the Redis denylist entry follows commit. It used
  /// to revoke the user session in a second transaction after the audited one, so a
  /// failure there left a row saying the session was revoked while its refresh token
  /// still worked. Revoking an already-revoked session changes and logs nothing.
  async revokeSession(sessionId: string, actor: AuditActor): Promise<void> {
    const revokedUserSession = await this.transactionManager.execute(async (tx) => {
      await lockForAudit(tx, 'admin_sessions', sessionId);
      const adminSession = await tx.adminSession.findUnique({ where: { id: sessionId } });
      if (!adminSession) throw new AdminSessionNotFoundError();

      const userSession = await tx.userSession.findFirst({
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

      const alreadyRevoked = adminSession.revokedAt !== null;
      if (!alreadyRevoked) {
        await tx.adminSession.update({
          where: { id: sessionId },
          data: { revokedAt: new Date() },
        });
      }
      const userSessionRevoked = userSession
        ? await this.sessionService.revokeInTransaction(userSession.id, 'logout', tx)
        : false;
      if (alreadyRevoked && !userSessionRevoked) return null;

      await recordAdminAction(tx, {
        ...actor,
        action: 'LOGOUT',
        entityType: 'admin_session',
        entityId: sessionId,
        summary: 'Admin session revoked',
        before: { revoked: alreadyRevoked },
        after: { revoked: true, userSessionRevoked, userId: adminSession.userId },
        result: 'SUCCESS',
      });
      return userSessionRevoked && userSession ? userSession.id : null;
    });

    if (revokedUserSession) await this.sessionService.afterRevoke(revokedUserSession, 'logout');
  }

  /// One transaction per staff account: its sessions, refresh tokens, admin sessions, its
  /// audit row and an `account.sessions.force_revoked` outbox event commit together, so an
  /// audit row exists exactly for the accounts that were logged out.
  ///
  /// Two kinds of failure, kept apart:
  /// - The transaction fails (database, or the in-transaction epoch bump): that account is
  ///   unchanged and unlogged. The loop still logs out everyone else, then the request
  ///   fails — a partial run is never reported as complete.
  /// - The transaction commits but the post-commit epoch bump fails: the account IS logged
  ///   out and audited. It is reported as `cacheInvalidation: 'PENDING'`, not as a failure;
  ///   the committed outbox event bumps the epoch again when relayed, which completes it.
  async forceLogoutAll(actor: AuditActor, userId?: string): Promise<ForceLogoutResult> {
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
    let accountsLoggedOut = 0;
    const failed: string[] = [];
    const cachePending: string[] = [];
    for (const user of staffUsers) {
      let revoked: number | null;
      try {
        revoked = await this.forceLogoutUser(user.id, actor, now, userId === undefined);
      } catch (err) {
        logger.error(
          { err, userId: user.id },
          '[admin-security] force logout rolled back for account',
        );
        failed.push(user.id);
        continue;
      }
      if (revoked === null) continue;
      revokedCount += revoked;
      accountsLoggedOut += 1;
      try {
        await this.epochService.bump(user.id);
      } catch (err) {
        logger.warn(
          { err, userId: user.id },
          '[admin-security] force logout committed; epoch bump pending reconciliation via outbox',
        );
        cachePending.push(user.id);
      }
    }
    if (failed.length > 0) {
      throw new ForceLogoutIncompleteError(accountsLoggedOut, failed.length);
    }
    return {
      revokedCount,
      accountsLoggedOut,
      cacheInvalidation: cachePending.length > 0 ? 'PENDING' : 'COMPLETE',
      cacheInvalidationPending: cachePending,
    };
  }

  /// Null when the account is not staff: nothing is changed and nothing is logged. Throws
  /// only when the transaction rolled back; the post-commit epoch bump is the caller's.
  ///
  /// The epoch is bumped inside the transaction, as staff removal does, so a revocation
  /// store that cannot be written aborts this account's change rather than leaving its
  /// access tokens valid.
  private async forceLogoutUser(
    userId: string,
    actor: AuditActor,
    now: Date,
    allStaff: boolean,
  ): Promise<number | null> {
    return this.transactionManager.execute(async (tx) => {
      await lockForAudit(tx, 'users', userId);
      const roles = await tx.userRoleAssignment.findMany({
        where: {
          userId,
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        include: { role: { select: { slug: true } } },
      });
      if (!roles.some((r) => isStaffRoleSlug(r.role.slug))) return null;

      const sessionsRevoked = await this.sessionService.revokeAllInTransaction(
        userId,
        'admin_force_logout',
        tx,
      );
      const { count: adminSessionsRevoked } = await tx.adminSession.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now },
      });
      await this.eventPublisher.publish(
        authEvent('account.sessions.force_revoked', {
          subjectUserId: userId,
          data: { userId, reason: 'admin_force_logout' },
        }),
        tx,
      );
      await recordAdminAction(tx, {
        ...actor,
        action: 'LOGOUT',
        entityType: 'staff_user',
        entityId: userId,
        summary: allStaff ? 'Force logout (all staff accounts)' : 'Force logout',
        after: { sessionsRevoked, adminSessionsRevoked, tokensInvalidated: true },
        result: 'SUCCESS',
      });
      await this.epochService.bump(userId);
      return adminSessionsRevoked;
    });
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

  async getPolicy(tx?: TransactionClient): Promise<SecurityPolicyDto> {
    const raw = await this.systemSettingService.getSettingValue(SECURITY_POLICY_KEY, tx);
    if (!raw) return { ...DEFAULT_POLICY };
    try {
      const parsed = JSON.parse(raw) as Partial<SecurityPolicyDto>;
      return { ...DEFAULT_POLICY, ...parsed };
    } catch {
      return { ...DEFAULT_POLICY };
    }
  }

  /// The policy is one JSON value merged with each patch, so the read, the merge, the write
  /// and the audit row share one transaction behind a lock. Without it two concurrent
  /// patches each merged into the same stale read, the second silently undoing the first,
  /// and both rows recorded a `before` that was no longer true.
  async updatePolicy(
    input: Partial<SecurityPolicyDto>,
    actor: AuditActor,
  ): Promise<SecurityPolicyDto> {
    const patch = Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined),
    ) as Partial<SecurityPolicyDto>;

    return this.transactionManager.execute(async (tx) => {
      await lockForAuditKey(tx, `settings:${SECURITY_POLICY_CATEGORY}`);
      const before = await this.getPolicy(tx);
      const after = { ...before, ...patch };
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
        ...actor,
        action: 'UPDATE',
        entityType: 'security_policy',
        summary: 'Security policy updated',
        before,
        after,
        result: 'SUCCESS',
      });
      return after;
    });
  }
}
