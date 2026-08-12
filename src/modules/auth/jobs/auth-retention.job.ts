import { RedisService } from '@core/cache';
import type { JwtConfig } from '@config/jwt/jwt.config';
import type { OtpConfig } from '@config/otp/otp.config';
import { logger } from '@shared/logger/index.js';
import { OtpRepository } from '../repositories/otp.repository';
import { RefreshTokenRepository } from '../repositories/refresh-token.repository';
import { SessionMetrics } from '../metrics';

const RETENTION_LOCK = 'auth:retention';

const RETENTION_LOCK_TTL_MS = 15 * 60 * 1000;

const BATCH_SIZE = 1_000;

const MAX_BATCHES = 200;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface AuthRetentionResult {
  ran: boolean;
  otpRowsDeleted: number;
  refreshTokensDeleted: number;
  moreRemaining: boolean;
}

export class AuthRetentionJob {
  constructor(
    private readonly otpRepository: OtpRepository,
    private readonly refreshTokenRepository: RefreshTokenRepository,
    private readonly redisService: RedisService,
    private readonly sessionMetrics: SessionMetrics,
    private readonly otpConfig: OtpConfig,
    private readonly jwtConfig: JwtConfig,
  ) {}

  async run(now: Date = new Date()): Promise<AuthRetentionResult> {
    const token = await this.redisService.lock.acquire(RETENTION_LOCK, RETENTION_LOCK_TTL_MS);
    if (!token) {
      return { ran: false, otpRowsDeleted: 0, refreshTokensDeleted: 0, moreRemaining: false };
    }

    try {
      const otp = await this.drain('otp_verifications', (limit) =>
        this.otpRepository.purgeExpired(
          new Date(now.getTime() - this.otpConfig.trailRetentionDays * DAY_MS),
          limit,
        ),
      );

      const refresh = await this.drain('refresh_tokens', (limit) =>
        this.refreshTokenRepository.purgeExpired(
          new Date(now.getTime() - this.jwtConfig.revokedRetentionDays * DAY_MS),
          limit,
        ),
      );

      this.sessionMetrics.retentionPurged({
        otpRows: otp.deleted,
        refreshTokens: refresh.deleted,
        moreRemaining: otp.more || refresh.more,
      });

      return {
        ran: true,
        otpRowsDeleted: otp.deleted,
        refreshTokensDeleted: refresh.deleted,
        moreRemaining: otp.more || refresh.more,
      };
    } finally {
      await this.redisService.lock.release(RETENTION_LOCK, token);
    }
  }

  private async drain(
    table: string,
    deleteBatch: (limit: number) => Promise<number>,
  ): Promise<{ deleted: number; more: boolean }> {
    let deleted = 0;

    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      const removed = await deleteBatch(BATCH_SIZE);
      deleted += removed;
      if (removed < BATCH_SIZE) return { deleted, more: false };
    }

    logger.warn(
      { table, deleted, batches: MAX_BATCHES },
      '[auth] retention hit its per-run batch budget; the rest drains next run',
    );
    return { deleted, more: true };
  }
}
