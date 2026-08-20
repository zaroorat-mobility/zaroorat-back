import { BaseRepository, DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { RefreshToken } from '@core/database/types';
export interface CreateRefreshTokenInput {
  userId: string;
  sessionId: string;
  tokenHash: string;
  expiresAt: Date;
  rotatedFrom?: string | null;
}
export class RefreshTokenRepository extends BaseRepository {
  constructor(databaseService: DatabaseService) {
    super(databaseService);
  }
  async create(input: CreateRefreshTokenInput, tx?: TransactionClient): Promise<RefreshToken> {
    return (tx ?? this.client).refreshToken.create({
      data: {
        userId: input.userId,
        sessionId: input.sessionId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        ...(input.rotatedFrom != null ? { rotatedFrom: input.rotatedFrom } : {}),
      },
    });
  }
  async findByHash(tokenHash: string, tx?: TransactionClient): Promise<RefreshToken | null> {
    return (tx ?? this.client).refreshToken.findUnique({ where: { tokenHash } });
  }
  async claimForRotation(
    id: string,
    tx: TransactionClient,
    at: Date = new Date(),
  ): Promise<boolean> {
    const { count } = await tx.refreshToken.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: at, revokedReason: 'rotated' },
    });
    return count === 1;
  }
  async linkRotation(id: string, rotatedToId: string, tx: TransactionClient): Promise<void> {
    await tx.refreshToken.updateMany({ where: { id }, data: { rotatedTo: rotatedToId } });
  }
  async markRotated(id: string, rotatedToId: string, revokedAt: Date = new Date()): Promise<void> {
    await this.client.refreshToken.update({
      where: { id },
      data: { rotatedTo: rotatedToId, revokedAt, revokedReason: 'rotated' },
    });
  }
  async revoke(id: string, reason: string, revokedAt: Date = new Date()): Promise<void> {
    await this.client.refreshToken.update({
      where: { id },
      data: { revokedAt, revokedReason: reason },
    });
  }
  async revokeBySession(
    sessionId: string,
    reason: string,
    revokedAt: Date = new Date(),
    tx?: TransactionClient,
  ): Promise<number> {
    const { count } = await (tx ?? this.client).refreshToken.updateMany({
      where: { sessionId, revokedAt: null },
      data: { revokedAt, revokedReason: reason },
    });
    return count;
  }
  async revokeAllByUser(
    userId: string,
    reason: string,
    revokedAt: Date = new Date(),
    tx?: TransactionClient,
  ): Promise<number> {
    const { count } = await (tx ?? this.client).refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt, revokedReason: reason },
    });
    return count;
  }
  async purgeExpired(before: Date, limit: number): Promise<number> {
    return this.client.$executeRaw`
      DELETE FROM "refresh_tokens"
      WHERE "id" IN (
        SELECT "id" FROM "refresh_tokens"
        WHERE "expires_at" < ${before}
        ORDER BY "expires_at" ASC
        LIMIT ${limit}
      )`;
  }
}
