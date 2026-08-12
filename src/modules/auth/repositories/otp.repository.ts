import { BaseRepository, DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { OtpVerification, OtpPurpose } from '@core/database/types';

export type OtpOutcome = 'sent' | 'verified' | 'failed' | 'expired' | 'locked';

export interface CreateOtpAttemptInput {
  phoneNumber: string;
  purpose: OtpPurpose;
  userId?: string | null;
  ipAddress?: string | null;
  deviceId?: string | null;
  deviceFingerprint?: string | null;
  userAgent?: string | null;
  provider?: string | null;
  providerRef?: string | null;
  latencyMs?: number | null;
  failureReason?: string | null;
  outcome?: OtpOutcome | null;
  expiresAt: Date;
}

export interface UpdateOutcomeOptions {
  verifiedAt?: Date;
  failureReason?: string;
}

export class OtpRepository extends BaseRepository {
  constructor(databaseService: DatabaseService) {
    super(databaseService);
  }

  async create(input: CreateOtpAttemptInput): Promise<OtpVerification> {
    return this.client.otpVerification.create({
      data: {
        phoneNumber: input.phoneNumber,
        purpose: input.purpose,
        expiresAt: input.expiresAt,
        ...(input.userId != null ? { userId: input.userId } : {}),
        ...(input.ipAddress != null ? { ipAddress: input.ipAddress } : {}),
        ...(input.deviceId != null ? { deviceId: input.deviceId } : {}),
        ...(input.deviceFingerprint != null ? { deviceFingerprint: input.deviceFingerprint } : {}),
        ...(input.userAgent != null ? { userAgent: input.userAgent } : {}),
        ...(input.provider != null ? { provider: input.provider } : {}),
        ...(input.providerRef != null ? { providerRef: input.providerRef } : {}),
        ...(input.latencyMs != null ? { latencyMs: input.latencyMs } : {}),
        ...(input.failureReason != null ? { failureReason: input.failureReason } : {}),
        ...(input.outcome != null ? { outcome: input.outcome } : {}),
      },
    });
  }

  async findById(id: string): Promise<OtpVerification | null> {
    return this.client.otpVerification.findUnique({ where: { id } });
  }

  async updateOutcome(
    id: string,
    outcome: OtpOutcome,
    options?: UpdateOutcomeOptions,
  ): Promise<boolean> {
    const { count } = await this.client.otpVerification.updateMany({
      where: { id, verifiedAt: null },
      data: {
        outcome,
        ...(options?.verifiedAt ? { verifiedAt: options.verifiedAt } : {}),
        ...(options?.failureReason ? { failureReason: options.failureReason } : {}),
      },
    });
    return count === 1;
  }

  async countByPhoneSince(phoneNumber: string, since: Date): Promise<number> {
    return this.client.otpVerification.count({
      where: { phoneNumber, createdAt: { gte: since } },
    });
  }

  async deleteForUser(
    userId: string,
    phoneNumber: string,
    tx?: TransactionClient,
  ): Promise<number> {
    const { count } = await (tx ?? this.client).otpVerification.deleteMany({
      where: { OR: [{ userId }, { phoneNumber }] },
    });
    return count;
  }

  async purgeExpired(before: Date, limit: number): Promise<number> {
    return this.client.$executeRaw`
      DELETE FROM "otp_verifications"
      WHERE "id" IN (
        SELECT "id" FROM "otp_verifications"
        WHERE "expires_at" < ${before}
        ORDER BY "expires_at" ASC
        LIMIT ${limit}
      )`;
  }
}
