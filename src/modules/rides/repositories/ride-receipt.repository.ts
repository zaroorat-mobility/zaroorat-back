import { randomUUID } from 'node:crypto';
import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import { Prisma } from '../../../generated/prisma';
import type { RideReceipt } from '../types';

export class RideReceiptRepository {
  constructor(private readonly db: DatabaseService) {}

  async create(
    rideId: string,
    snapshotJson: Prisma.InputJsonValue,
    pdfUrl?: string | null,
    tx?: TransactionClient,
  ): Promise<RideReceipt> {
    const client = tx ?? this.db.client;
    const receiptNumber = `RCP_${Date.now().toString(36).toUpperCase()}_${randomUUID().substring(0, 4).toUpperCase()}`;

    return client.rideReceipt.create({
      data: {
        rideId,
        receiptNumber,
        snapshotJson,
        ...(pdfUrl !== undefined ? { pdfUrl } : {}),
      },
    });
  }

  async findByRideId(rideId: string, tx?: TransactionClient): Promise<RideReceipt | null> {
    const client = tx ?? this.db.client;
    return client.rideReceipt.findUnique({
      where: { rideId },
    });
  }
}
