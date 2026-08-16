import { BaseRepository, DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
export interface DeletionRequest {
  id: string;
  userId: string;
  status: string;
  requestedAt: Date;
  scheduledFor: Date;
  erasedAt: Date | null;
  cancelledAt: Date | null;
}
export class DeletionRequestRepository extends BaseRepository {
  constructor(databaseService: DatabaseService) {
    super(databaseService);
  }
  async open(userId: string, scheduledFor: Date, tx?: TransactionClient): Promise<DeletionRequest> {
    const client = tx ?? this.client;
    const existing = await client.accountDeletionRequest.findFirst({
      where: { userId, status: 'PENDING' },
    });
    if (existing) return existing;
    return client.accountDeletionRequest.create({ data: { userId, scheduledFor } });
  }
  async findPending(userId: string, tx?: TransactionClient): Promise<DeletionRequest | null> {
    return (tx ?? this.client).accountDeletionRequest.findFirst({
      where: { userId, status: 'PENDING' },
    });
  }
  async findById(id: string, tx?: TransactionClient): Promise<DeletionRequest | null> {
    return (tx ?? this.client).accountDeletionRequest.findUnique({ where: { id } });
  }
  async findDue(now: Date, limit: number): Promise<DeletionRequest[]> {
    return this.client.accountDeletionRequest.findMany({
      where: { status: 'PENDING', scheduledFor: { lte: now } },
      orderBy: { scheduledFor: 'asc' },
      take: limit,
    });
  }
  async markErased(id: string, erasedAt: Date, tx?: TransactionClient): Promise<boolean> {
    const { count } = await (tx ?? this.client).accountDeletionRequest.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'ERASED', erasedAt },
    });
    return count === 1;
  }
  async cancelForUser(userId: string, cancelledAt: Date, tx?: TransactionClient): Promise<number> {
    const { count } = await (tx ?? this.client).accountDeletionRequest.updateMany({
      where: { userId, status: 'PENDING' },
      data: { status: 'CANCELLED', cancelledAt },
    });
    return count;
  }
}
