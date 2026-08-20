import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { RideOtp } from '../types';
export class RideOtpRepository {
  constructor(private readonly db: DatabaseService) {}
  async create(
    data: {
      rideId: string;
      otpHash: string;
      purpose?: string;
      expiresAt: Date;
    },
    tx?: TransactionClient,
  ): Promise<RideOtp> {
    const client = tx ?? this.db.client;
    return client.rideOtp.create({
      data: {
        rideId: data.rideId,
        otpHash: data.otpHash,
        purpose: data.purpose ?? 'START',
        attempts: 0,
        verified: false,
        expiresAt: data.expiresAt,
      },
    });
  }
  async findLatestByRideId(rideId: string, tx?: TransactionClient): Promise<RideOtp | null> {
    const client = tx ?? this.db.client;
    return client.rideOtp.findFirst({
      where: { rideId, verified: false },
      orderBy: { createdAt: 'desc' },
    });
  }
  async markVerified(id: string, tx?: TransactionClient): Promise<RideOtp> {
    const client = tx ?? this.db.client;
    return client.rideOtp.update({
      where: { id },
      data: {
        verified: true,
        verifiedAt: new Date(),
      },
    });
  }
  async incrementAttempts(id: string, tx?: TransactionClient): Promise<RideOtp> {
    const client = tx ?? this.db.client;
    return client.rideOtp.update({
      where: { id },
      data: {
        attempts: { increment: 1 },
      },
    });
  }
  async claimAttempt(id: string, maxAttempts: number, tx?: TransactionClient): Promise<boolean> {
    const client = tx ?? this.db.client;
    const { count } = await client.rideOtp.updateMany({
      where: { id, verified: false, attempts: { lt: maxAttempts } },
      data: { attempts: { increment: 1 } },
    });
    return count === 1;
  }
  async claimVerification(id: string, tx?: TransactionClient): Promise<boolean> {
    const client = tx ?? this.db.client;
    const { count } = await client.rideOtp.updateMany({
      where: { id, verified: false },
      data: { verified: true, verifiedAt: new Date() },
    });
    return count === 1;
  }
}
