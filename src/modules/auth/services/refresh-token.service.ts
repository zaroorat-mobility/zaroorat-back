import { createHmac, randomBytes } from 'node:crypto';
import { EventPublisher } from '@core/events';
import { TransactionManager } from '@core/database/TransactionManager';
import type { JwtConfig } from '@config/jwt/jwt.config';
import { RefreshTokenRepository } from '../repositories/refresh-token.repository';
import { TokenInvalidError, TokenReuseError } from '../errors';
import { authEvent } from '../events';
import { EpochService } from './epoch.service';

/** A freshly issued refresh token. The raw `token` is returned to the client
 *  exactly once and never persisted — only its hash is stored. */
export interface IssuedRefreshToken {
  token: string;
  id: string;
  expiresAt: Date;
}

/** Result of a successful rotation. */
export interface RotationResult {
  userId: string;
  sessionId: string;
  refresh: IssuedRefreshToken;
}

/**
 * Refresh-token lifecycle: issue, rotate, reuse-detect, and family-revoke
 * (auth doc 02 §3.2).
 *
 * Tokens are opaque 256-bit CSPRNG values; only their HMAC-SHA256 digest (keyed
 * by the pepper) is stored. Every use rotates the token; replay of a consumed
 * token is treated as theft — the whole session family is revoked and the user
 * epoch bumped (AUTH-INV-5). Atomic rotation is delegated to the repository.
 */
export class RefreshTokenService {
  private readonly pepper: string;
  private readonly ttlSeconds: number;

  /**
   * @param refreshTokenRepository Persistence for refresh tokens (hash only).
   * @param epochService Epoch authority (bumped on reuse).
   * @param eventPublisher Emits refresh lifecycle events.
   * @param transactionManager Commits the reuse family-revoke and its audit event atomically.
   * @param jwtConfig Supplies the refresh pepper and TTL.
   */
  constructor(
    private readonly refreshTokenRepository: RefreshTokenRepository,
    private readonly epochService: EpochService,
    private readonly eventPublisher: EventPublisher,
    private readonly transactionManager: TransactionManager,
    jwtConfig: JwtConfig,
  ) {
    this.pepper = jwtConfig.refreshSecret;
    this.ttlSeconds = jwtConfig.refreshTtlSeconds;
  }

  /**
   * Issue a new refresh token for a session.
   * @param userId Owner user UUID.
   * @param sessionId Session (`sid`) the token belongs to.
   * @returns The issued token (raw value + row id + expiry).
   */
  async issue(userId: string, sessionId: string): Promise<IssuedRefreshToken> {
    const raw = this.generateRawToken();
    const expiresAt = new Date(Date.now() + this.ttlSeconds * 1000);
    const row = await this.refreshTokenRepository.create({
      userId,
      sessionId,
      tokenHash: this.hash(raw),
      expiresAt,
    });
    return { token: raw, id: row.id, expiresAt };
  }

  /**
   * Rotate a presented refresh token.
   *
   * Unknown/expired → {@link TokenInvalidError}. A presented token that is
   * already consumed/revoked is reuse: the session family is revoked, the epoch
   * bumped, and {@link TokenReuseError} thrown. Otherwise the token is atomically
   * consumed and a successor issued.
   * @param presentedToken The raw refresh token from the client.
   * @returns The owner/session plus the newly issued successor token.
   * @throws {TokenInvalidError} Unknown or expired token.
   * @throws {TokenReuseError} Replay of a consumed token.
   */
  async rotate(presentedToken: string): Promise<RotationResult> {
    const existing = await this.refreshTokenRepository.findByHash(this.hash(presentedToken));
    if (!existing) throw new TokenInvalidError();

    if (existing.revokedAt) {
      // Reuse of a consumed token is treated as theft. Revoke the whole family
      // and write the audit event in one transaction, so the record of the
      // detection can never be lost while the tokens are revoked. The epoch bump
      // is a Redis write, so it runs after the transaction commits.
      await this.transactionManager.execute(async (tx) => {
        await this.refreshTokenRepository.revokeBySession(
          existing.sessionId,
          'reuse_detected',
          undefined,
          tx,
        );
        await this.eventPublisher.publish(
          authEvent('auth.refresh.reuse_detected', {
            aggregateId: existing.sessionId,
            subjectUserId: existing.userId,
            sessionId: existing.sessionId,
            data: { userId: existing.userId, sessionId: existing.sessionId },
          }),
          tx,
        );
      });
      await this.epochService.bump(existing.userId);
      throw new TokenReuseError();
    }

    if (existing.expiresAt.getTime() <= Date.now()) {
      throw new TokenInvalidError('The refresh token has expired');
    }

    const raw = this.generateRawToken();
    const created = await this.refreshTokenRepository.rotate(existing.id, {
      userId: existing.userId,
      sessionId: existing.sessionId,
      tokenHash: this.hash(raw),
      expiresAt: new Date(Date.now() + this.ttlSeconds * 1000),
    });

    await this.eventPublisher.publish(
      authEvent('auth.token.refreshed', {
        aggregateId: existing.sessionId,
        subjectUserId: existing.userId,
        sessionId: existing.sessionId,
        data: {
          userId: existing.userId,
          sessionId: existing.sessionId,
          rotatedFrom: existing.id,
          rotatedTo: created.id,
        },
      }),
    );

    return {
      userId: existing.userId,
      sessionId: existing.sessionId,
      refresh: { token: raw, id: created.id, expiresAt: created.expiresAt },
    };
  }

  /**
   * Revoke every active token in a session's family and bump the user epoch — a
   * forced family kill (e.g. an admin-driven theft response). The reuse path in
   * {@link rotate} inlines an equivalent, transactional revoke so its audit event
   * commits atomically; this remains as a standalone, non-audited operation.
   * @param sessionId The session whose token family to revoke.
   * @param userId Owner user UUID (whose epoch is bumped).
   * @param reason Revocation reason recorded on the tokens.
   */
  async revokeFamily(sessionId: string, userId: string, reason: string): Promise<void> {
    await this.refreshTokenRepository.revokeBySession(sessionId, reason);
    await this.epochService.bump(userId);
  }

  /** Generate a 256-bit opaque token, base64url-encoded. */
  private generateRawToken(): string {
    return randomBytes(32).toString('base64url');
  }

  /** HMAC-SHA256(token, pepper) → hex digest (never the raw token). */
  private hash(token: string): string {
    return createHmac('sha256', this.pepper).update(token).digest('hex');
  }
}
