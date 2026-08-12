import { RedisService } from '@core/cache';
import { EventPublisher } from '@core/events';
import { TransactionManager, type TransactionClient } from '@core/database/TransactionManager';
import type { UserSession } from '@core/database/types';
import type { SessionConfig } from '@config/session/session.config';
import { logger } from '@shared/logger/index.js';
import { SessionRepository } from '../../repositories/session.repository';
import { RefreshTokenRepository } from '../../repositories/refresh-token.repository';
import { UserRepository } from '../../repositories/user.repository';
import { EpochService } from '../token/epoch.service';
import { authEvent } from '../../events';
import { SessionMetrics } from '../../metrics';

export interface CreateSessionInput {
  userId: string;
  deviceId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  loginMethod?: string | null;
  expiresAt: Date;
  maxConcurrentSessions?: number;
}

export class SessionService {
  constructor(
    private readonly sessionRepository: SessionRepository,
    private readonly refreshTokenRepository: RefreshTokenRepository,
    private readonly userRepository: UserRepository,
    private readonly redisService: RedisService,
    private readonly epochService: EpochService,
    private readonly sessionMetrics: SessionMetrics,
    private readonly eventPublisher: EventPublisher,
    private readonly transactionManager: TransactionManager,
    private readonly sessionConfig: SessionConfig,
  ) {}

  async create(input: CreateSessionInput): Promise<UserSession> {
    const session = await this.createInTransaction(input);
    await this.enforceCap(input.userId, this.capFor(input), session.id);
    return session;
  }

  async createInTransaction(
    input: CreateSessionInput,
    tx?: TransactionClient,
  ): Promise<UserSession> {
    const session = await this.sessionRepository.create(
      {
        userId: input.userId,
        expiresAt: input.expiresAt,
        ...(input.deviceId != null ? { deviceId: input.deviceId } : {}),
        ...(input.ipAddress != null ? { ipAddress: input.ipAddress } : {}),
        ...(input.userAgent != null ? { userAgent: input.userAgent } : {}),
        ...(input.loginMethod != null ? { loginMethod: input.loginMethod } : {}),
      },
      tx,
    );
    this.sessionMetrics.created({ userId: input.userId });
    return session;
  }

  private capFor(input: CreateSessionInput): number {
    return input.maxConcurrentSessions ?? this.sessionConfig.maxConcurrentSessions;
  }

  async listSessions(userId: string): Promise<UserSession[]> {
    return this.sessionRepository.findActiveByUser({ userId });
  }

  async deviceIdFor(sessionId: string): Promise<string | null> {
    const session = await this.sessionRepository.findById(sessionId);
    return session?.deviceId ?? null;
  }

  async revokeForUser(userId: string, sessionId: string): Promise<boolean> {
    const session = await this.sessionRepository.findById(sessionId);
    if (!session || session.userId !== userId) return false;
    await this.revokeSession(sessionId, 'logout');
    return true;
  }

  async logout(sessionId: string): Promise<void> {
    await this.revokeSession(sessionId, 'logout');
  }

  async logoutAll(userId: string, reason: string = 'logout'): Promise<void> {
    await this.transactionManager.execute((tx) => this.revokeAllInTransaction(userId, reason, tx));
    await this.epochService.bump(userId);
    this.sessionMetrics.logoutAll({ userId, reason });
  }

  async revokeAllInTransaction(
    userId: string,
    reason: string,
    tx: TransactionClient,
  ): Promise<number> {
    const active = await this.sessionRepository.findActiveByUser({ userId, tx });
    await this.sessionRepository.revokeAllByUser(userId, reason, undefined, tx);
    await this.refreshTokenRepository.revokeAllByUser(userId, reason, undefined, tx);
    for (const session of active) {
      await this.eventPublisher.publish(
        authEvent('auth.session.revoked', {
          aggregateId: session.id,
          subjectUserId: userId,
          sessionId: session.id,
          data: { userId, sessionId: session.id, reason },
        }),
        tx,
      );
    }
    return active.length;
  }

  async revokeDeviceSessions(deviceId: string): Promise<number> {
    const active = await this.sessionRepository.findActiveByDevice(deviceId);
    let revoked = 0;
    for (const session of active) {
      if (await this.revokeSession(session.id, 'device_revoked')) revoked += 1;
    }
    return revoked;
  }

  async touchLastSeen(sessionId: string, at: Date = new Date()): Promise<void> {
    await this.sessionRepository.touchLastSeen(sessionId, at);
  }

  async touchLastSeenThrottled(sessionId: string, at: Date = new Date()): Promise<boolean> {
    try {
      const window = this.sessionConfig.lastSeenThrottleSeconds;
      if (window <= 0) {
        await this.sessionRepository.touchLastSeen(sessionId, at);
        return true;
      }
      const token = await this.redisService.lock.acquire(
        `session:seen:${sessionId}`,
        window * 1000,
      );
      if (!token) return false;
      await this.sessionRepository.touchLastSeen(sessionId, at);
      return true;
    } catch (err) {
      logger.warn({ err, sessionId }, '[auth] last-seen update failed; timestamp is stale');
      return false;
    }
  }

  private async revokeSession(sessionId: string, reason: string): Promise<boolean> {
    const won = await this.transactionManager.execute((tx) =>
      this.revokeInTransaction(sessionId, reason, tx),
    );
    if (!won) return false;

    await this.afterRevoke(sessionId, reason);
    return true;
  }

  private async revokeInTransaction(
    sessionId: string,
    reason: string,
    tx: TransactionClient,
  ): Promise<boolean> {
    const acquired = await this.sessionRepository.revoke(sessionId, reason, undefined, tx);
    if (!acquired) return false;

    await this.refreshTokenRepository.revokeBySession(sessionId, reason, undefined, tx);
    const owner = (await this.sessionRepository.findById(sessionId, tx))?.userId ?? null;
    await this.eventPublisher.publish(
      authEvent('auth.session.revoked', {
        aggregateId: sessionId,
        subjectUserId: owner,
        sessionId,
        data: { userId: owner, sessionId, reason },
      }),
      tx,
    );
    return true;
  }

  private async afterRevoke(sessionId: string, reason: string): Promise<void> {
    await this.redisService.sidBlacklist.revoke(sessionId, this.sessionConfig.denylistTtlSeconds);
    if (reason === 'cap_evicted') this.sessionMetrics.capEvicted({ reason });
    this.sessionMetrics.revoked({ reason });
  }

  async enforceCap(userId: string, cap: number, keepSessionId: string): Promise<void> {
    const evicted = await this.transactionManager.execute(async (tx) => {
      await this.userRepository.lockForUpdate(userId, tx);

      const active = await this.sessionRepository.findActiveByUser({ userId, tx });
      if (active.length <= cap) return [];

      const toEvict = active
        .filter((session) => session.id !== keepSessionId)
        .slice(0, active.length - cap);

      const revoked: string[] = [];
      for (const session of toEvict) {
        if (await this.revokeInTransaction(session.id, 'cap_evicted', tx)) {
          revoked.push(session.id);
        }
      }
      return revoked;
    });

    for (const sessionId of evicted) await this.afterRevoke(sessionId, 'cap_evicted');
  }
}
