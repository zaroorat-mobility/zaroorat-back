import { BaseRepository, DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { UserSession } from '@core/database/types';
export interface CreateSessionInput {
  userId: string;
  deviceId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  loginMethod?: string | null;
  expiresAt: Date;
}
export interface FindActiveSessionsOptions {
  userId: string;
  now?: Date;
  tx?: TransactionClient;
  limit?: number;
}
export class SessionRepository extends BaseRepository {
  constructor(databaseService: DatabaseService) {
    super(databaseService);
  }
  async create(input: CreateSessionInput, tx?: TransactionClient): Promise<UserSession> {
    return (tx ?? this.client).userSession.create({
      data: {
        userId: input.userId,
        expiresAt: input.expiresAt,
        ...(input.deviceId != null ? { deviceId: input.deviceId } : {}),
        ...(input.ipAddress != null ? { ipAddress: input.ipAddress } : {}),
        ...(input.userAgent != null ? { userAgent: input.userAgent } : {}),
        ...(input.loginMethod != null ? { loginMethod: input.loginMethod } : {}),
      },
    });
  }
  async findById(id: string, tx?: TransactionClient): Promise<UserSession | null> {
    return (tx ?? this.client).userSession.findUnique({ where: { id } });
  }
  async findActiveByUser(options: FindActiveSessionsOptions): Promise<UserSession[]> {
    return (options.tx ?? this.client).userSession.findMany({
      where: {
        userId: options.userId,
        revokedAt: null,
        expiresAt: { gt: options.now ?? new Date() },
      },
      orderBy: { createdAt: 'asc' },
      ...(options.limit !== undefined ? { take: options.limit } : {}),
    });
  }
  async countActiveByUser(userId: string, now: Date = new Date()): Promise<number> {
    return this.client.userSession.count({
      where: { userId, revokedAt: null, expiresAt: { gt: now } },
    });
  }
  async findOldestActiveByUser(
    userId: string,
    now: Date = new Date(),
  ): Promise<UserSession | null> {
    return this.client.userSession.findFirst({
      where: { userId, revokedAt: null, expiresAt: { gt: now } },
      orderBy: { createdAt: 'asc' },
    });
  }
  async findActiveByDevice(deviceId: string, now: Date = new Date()): Promise<UserSession[]> {
    return this.client.userSession.findMany({
      where: { deviceId, revokedAt: null, expiresAt: { gt: now } },
    });
  }
  async revoke(
    id: string,
    reason: string,
    revokedAt: Date = new Date(),
    tx?: TransactionClient,
  ): Promise<boolean> {
    const { count } = await (tx ?? this.client).userSession.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt, revokedReason: reason },
    });
    return count === 1;
  }
  async revokeAllByUser(
    userId: string,
    reason: string,
    revokedAt: Date = new Date(),
    tx?: TransactionClient,
  ): Promise<number> {
    const { count } = await (tx ?? this.client).userSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt, revokedReason: reason },
    });
    return count;
  }
  async touchLastSeen(id: string, at: Date = new Date()): Promise<void> {
    await this.client.userSession.update({ where: { id }, data: { lastSeenAt: at } });
  }
  async anonymizeForUser(userId: string, tx?: TransactionClient): Promise<number> {
    const { count } = await (tx ?? this.client).userSession.updateMany({
      where: { userId },
      data: { ipAddress: null, userAgent: null },
    });
    return count;
  }
}
