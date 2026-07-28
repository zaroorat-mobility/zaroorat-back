import { RedisService } from '@core/cache';
import { EventPublisher } from '@core/events';
import { TransactionManager } from '@core/database/TransactionManager';
import type { UserSession } from '@core/database/types';
import type { SessionConfig } from '@config/session/session.config';
import { SessionRepository } from '../repositories/session.repository';
import { RefreshTokenRepository } from '../repositories/refresh-token.repository';
import { EpochService } from '../services/epoch.service';
import { authEvent } from '../events';
import { SessionMetrics } from './session.metrics';

/** Inputs to open a session. */
export interface CreateSessionInput {
  userId: string;
  deviceId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  loginMethod?: string | null;
  expiresAt: Date;
  /** Override the concurrent-session cap (e.g. lower for privileged roles). */
  maxConcurrentSessions?: number;
}

/**
 * Session lifecycle: creation with concurrency-cap eviction, single logout,
 * global logout, device-scoped revocation, and last-seen tracking
 * (auth doc 02 §5.1, doc 04 §2.4).
 *
 * Revoking a specific session is DB-authoritative (row `revoked_at`) plus a
 * short-TTL `sid` denylist so the affected device is rejected on its next
 * request. Global logout instead bumps the user epoch, invalidating every
 * outstanding access token at once.
 */
export class SessionService {
  /**
   * @param sessionRepository Session persistence.
   * @param refreshTokenRepository Refresh tokens (revoked alongside sessions).
   * @param redisService Provides the `sid` denylist.
   * @param epochService Epoch authority (bumped on global logout).
   * @param transactionManager Runs the revoke + family revoke + audit event atomically.
   * @param sessionConfig Caps and denylist TTL.
   */
  constructor(
    private readonly sessionRepository: SessionRepository,
    private readonly refreshTokenRepository: RefreshTokenRepository,
    private readonly redisService: RedisService,
    private readonly epochService: EpochService,
    private readonly sessionMetrics: SessionMetrics,
    private readonly eventPublisher: EventPublisher,
    private readonly transactionManager: TransactionManager,
    private readonly sessionConfig: SessionConfig,
  ) {}

  /**
   * Open a session and enforce the concurrency cap (evicting the oldest active
   * sessions beyond the cap).
   * @param input Owner, optional device/ip/forensics, expiry, and cap override.
   * @returns The created session (its `id` is the `sid`).
   */
  async create(input: CreateSessionInput): Promise<UserSession> {
    const session = await this.sessionRepository.create({
      userId: input.userId,
      expiresAt: input.expiresAt,
      ...(input.deviceId != null ? { deviceId: input.deviceId } : {}),
      ...(input.ipAddress != null ? { ipAddress: input.ipAddress } : {}),
      ...(input.userAgent != null ? { userAgent: input.userAgent } : {}),
      ...(input.loginMethod != null ? { loginMethod: input.loginMethod } : {}),
    });
    this.sessionMetrics.created({ userId: input.userId });

    const cap = input.maxConcurrentSessions ?? this.sessionConfig.maxConcurrentSessions;
    await this.enforceCap(input.userId, cap, session.id);
    return session;
  }

  /**
   * List a user's currently active sessions (for self/admin session management).
   * @param userId Owner user UUID.
   * @returns Active sessions, oldest first.
   */
  async listSessions(userId: string): Promise<UserSession[]> {
    return this.sessionRepository.findActiveByUser(userId);
  }

  /**
   * Revoke a specific session, but only if it belongs to the caller.
   * @param userId The caller's user UUID.
   * @param sessionId The session (`sid`) to revoke.
   * @returns `true` if the session exists and is owned by the caller (then
   *          revoked, idempotently); `false` if unknown or not owned.
   */
  async revokeForUser(userId: string, sessionId: string): Promise<boolean> {
    const session = await this.sessionRepository.findById(sessionId);
    if (!session || session.userId !== userId) return false;
    await this.revokeSession(sessionId, 'logout');
    return true;
  }

  /**
   * Revoke the current session. Idempotent and race-safe: the revocation is an
   * atomic conditional update, so concurrent logouts do the side effects once.
   * @param sessionId Session UUID (`sid`).
   */
  async logout(sessionId: string): Promise<void> {
    await this.revokeSession(sessionId, 'logout');
  }

  /**
   * Revoke every session for a user and bump the epoch (sign out all devices).
   *
   * The bulk session/token revoke and one `auth.session.revoked` audit event per
   * affected `sid` commit in a **single transaction**, so the audit trail can
   * never diverge from the revocation. The epoch bump (a Redis write, which is
   * what enforces fast revocation globally) and metrics run after commit.
   * @param userId Owner user UUID.
   * @param reason Revocation reason (`logout` for user-initiated, `suspension` for ops).
   */
  async logoutAll(userId: string, reason: string = 'logout'): Promise<void> {
    const active = await this.sessionRepository.findActiveByUser(userId);
    await this.transactionManager.execute(async (tx) => {
      await this.sessionRepository.revokeAllByUser(userId, reason, undefined, tx);
      await this.refreshTokenRepository.revokeAllByUser(userId, reason, undefined, tx);
      for (const session of active) {
        await this.eventPublisher.publish(
          authEvent('auth.session.revoked', {
            aggregateId: session.id,
            sessionId: session.id,
            data: { sessionId: session.id, reason },
          }),
          tx,
        );
      }
    });
    await this.epochService.bump(userId);
    this.sessionMetrics.logoutAll({ userId, reason });
  }

  /**
   * Revoke every active session bound to a device (device revocation, INV-6).
   * @param deviceId Bound device UUID (`UserDevice.id`).
   * @returns Count of sessions actually revoked.
   */
  async revokeDeviceSessions(deviceId: string): Promise<number> {
    const active = await this.sessionRepository.findActiveByDevice(deviceId);
    let revoked = 0;
    for (const session of active) {
      if (await this.revokeSession(session.id, 'device_revoked')) revoked += 1;
    }
    return revoked;
  }

  /**
   * Update a session's last-seen timestamp (called on the request hot path).
   * @param sessionId Session UUID (`sid`).
   * @param at Observation instant.
   */
  async touchLastSeen(sessionId: string, at: Date = new Date()): Promise<void> {
    await this.sessionRepository.touchLastSeen(sessionId, at);
  }

  /**
   * Revoke one session across all tiers. The DB row revoke (atomic conditional),
   * the refresh-family revoke, and the `auth.session.revoked` audit event commit
   * in a **single transaction**, so a crash can never leave the session revoked
   * without its audit trail (or vice versa). The non-transactional side effects —
   * the `sid` denylist and metrics — run only after the transaction commits and
   * only if this call won the race, so concurrent callers never duplicate work.
   * @returns `true` if this call performed the revocation.
   */
  private async revokeSession(sessionId: string, reason: string): Promise<boolean> {
    const won = await this.transactionManager.execute(async (tx) => {
      const acquired = await this.sessionRepository.revoke(sessionId, reason, undefined, tx);
      if (!acquired) return false;
      await this.refreshTokenRepository.revokeBySession(sessionId, reason, undefined, tx);
      await this.eventPublisher.publish(
        authEvent('auth.session.revoked', {
          aggregateId: sessionId,
          sessionId,
          data: { sessionId, reason },
        }),
        tx,
      );
      return true;
    });
    if (!won) return false;

    await this.redisService.sidBlacklist.revoke(sessionId, this.sessionConfig.denylistTtlSeconds);
    if (reason === 'cap_evicted') this.sessionMetrics.capEvicted({ reason });
    this.sessionMetrics.revoked({ reason });
    return true;
  }

  /** Evict the oldest active sessions beyond the cap, keeping the newest. */
  private async enforceCap(userId: string, cap: number, keepSessionId: string): Promise<void> {
    const active = await this.sessionRepository.findActiveByUser(userId);
    if (active.length <= cap) return;

    const evictCount = active.length - cap;
    const toEvict = active.filter((s) => s.id !== keepSessionId).slice(0, evictCount);
    for (const session of toEvict) {
      await this.revokeSession(session.id, 'cap_evicted');
    }
  }
}
