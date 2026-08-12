import { createHmac, randomBytes } from 'node:crypto';
import { EventPublisher } from '@core/events';
import { TransactionManager, type TransactionClient } from '@core/database/TransactionManager';
import type { JwtConfig } from '@config/jwt/jwt.config';
import { RefreshTokenRepository } from '../../repositories/refresh-token.repository';
import { TokenInvalidError, TokenReuseError } from '../../errors/auth.errors';
import { authEvent } from '../../events';
import { EpochService } from './epoch.service';

export interface IssuedRefreshToken {
  token: string;
  id: string;
  expiresAt: Date;
}

export interface RotationResult {
  userId: string;
  sessionId: string;
  refresh: IssuedRefreshToken;
}

export class RefreshTokenService {
  private readonly pepper: string;
  private readonly ttlSeconds: number;

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

  async issue(
    userId: string,
    sessionId: string,
    tx?: TransactionClient,
  ): Promise<IssuedRefreshToken> {
    const raw = this.generateRawToken();
    const expiresAt = new Date(Date.now() + this.ttlSeconds * 1000);
    const row = await this.refreshTokenRepository.create(
      {
        userId,
        sessionId,
        tokenHash: this.hash(raw),
        expiresAt,
      },
      tx,
    );
    return { token: raw, id: row.id, expiresAt };
  }

  async rotate(presentedToken: string): Promise<RotationResult> {
    const outcome = await this.transactionManager.execute(async (tx) => {
      const existing = await this.refreshTokenRepository.findByHash(this.hash(presentedToken), tx);
      if (!existing) return { kind: 'unknown' } as const;

      if (existing.revokedAt) return { kind: 'reuse', token: existing } as const;
      if (existing.expiresAt.getTime() <= Date.now()) return { kind: 'expired' } as const;
      if (!(await this.refreshTokenRepository.claimForRotation(existing.id, tx))) {
        return { kind: 'reuse', token: existing } as const;
      }

      const raw = this.generateRawToken();
      const created = await this.refreshTokenRepository.create(
        {
          userId: existing.userId,
          sessionId: existing.sessionId,
          tokenHash: this.hash(raw),
          expiresAt: new Date(Date.now() + this.ttlSeconds * 1000),
          rotatedFrom: existing.id,
        },
        tx,
      );
      await this.refreshTokenRepository.linkRotation(existing.id, created.id, tx);

      return { kind: 'rotated', existing, created, raw } as const;
    });

    if (outcome.kind === 'unknown') throw new TokenInvalidError();
    if (outcome.kind === 'expired') {
      throw new TokenInvalidError('The refresh token has expired');
    }
    if (outcome.kind === 'reuse') {
      await this.handleReuse(outcome.token.sessionId, outcome.token.userId);
      throw new TokenReuseError();
    }

    const { existing, created, raw } = outcome;
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

  private async handleReuse(sessionId: string, userId: string): Promise<void> {
    await this.transactionManager.execute(async (tx) => {
      await this.refreshTokenRepository.revokeBySession(sessionId, 'reuse_detected', undefined, tx);
      await this.eventPublisher.publish(
        authEvent('auth.refresh.reuse_detected', {
          aggregateId: sessionId,
          subjectUserId: userId,
          sessionId,
          data: { userId, sessionId },
        }),
        tx,
      );
    });
    await this.epochService.bump(userId);
  }

  async revokeFamily(sessionId: string, userId: string, reason: string): Promise<void> {
    await this.refreshTokenRepository.revokeBySession(sessionId, reason);
    await this.epochService.bump(userId);
  }

  private generateRawToken(): string {
    return randomBytes(32).toString('base64url');
  }

  private hash(token: string): string {
    return createHmac('sha256', this.pepper).update(token).digest('hex');
  }
}
