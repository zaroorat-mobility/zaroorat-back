import { BaseRepository, DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { File, FilePurpose } from '@core/database/types';
export interface CreateFileInput {
  ownerUserId: string;
  purpose: FilePurpose;
  storageKey: string;
  storageProvider: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  uploadExpiresAt: Date;
  checksumSha256?: string | null;
  storageBucket?: string | null;
}
export interface CompleteFileInput {
  sizeBytes: number;
  completedAt: Date;
  checksumSha256: string | null;
  detectedContentType: string;
  uploadedAt: Date;
  verifiedAt: Date;
  storageBucket?: string | null;
  storageVersionId?: string | null;
}
export class FileRepository extends BaseRepository {
  constructor(databaseService: DatabaseService) {
    super(databaseService);
  }
  async create(input: CreateFileInput, tx?: TransactionClient): Promise<File> {
    return (tx ?? this.client).file.create({
      data: {
        ownerUserId: input.ownerUserId,
        purpose: input.purpose,
        storageKey: input.storageKey,
        storageProvider: input.storageProvider,
        ...(input.storageBucket != null ? { storageBucket: input.storageBucket } : {}),
        fileName: input.fileName,
        contentType: input.contentType,
        sizeBytes: input.sizeBytes,
        uploadExpiresAt: input.uploadExpiresAt,
        ...(input.checksumSha256 != null ? { checksumSha256: input.checksumSha256 } : {}),
      },
    });
  }
  async findOwned(id: string, ownerUserId: string, tx?: TransactionClient): Promise<File | null> {
    return (tx ?? this.client).file.findFirst({ where: { id, ownerUserId } });
  }
  async findReadable(id: string): Promise<File | null> {
    return this.client.file.findFirst({ where: { id, status: 'READY', deletedAt: null } });
  }
  async findById(id: string, tx?: TransactionClient): Promise<File | null> {
    return (tx ?? this.client).file.findUnique({ where: { id } });
  }
  async markReady(id: string, input: CompleteFileInput, tx: TransactionClient): Promise<boolean> {
    const { count } = await tx.file.updateMany({
      where: { id, status: { in: ['PENDING', 'UPLOADED'] } },
      data: {
        status: 'READY',
        sizeBytes: input.sizeBytes,
        checksumSha256: input.checksumSha256,
        detectedContentType: input.detectedContentType,
        uploadedAt: input.uploadedAt,
        verifiedAt: input.verifiedAt,
        completedAt: input.completedAt,
        ...(input.storageBucket != null ? { storageBucket: input.storageBucket } : {}),
        ...(input.storageVersionId != null ? { storageVersionId: input.storageVersionId } : {}),
      },
    });
    return count === 1;
  }
  async markRejected(
    id: string,
    reason: string,
    at: Date,
    tx?: TransactionClient,
  ): Promise<boolean> {
    const { count } = await (tx ?? this.client).file.updateMany({
      where: { id, status: { in: ['PENDING', 'UPLOADED'] } },
      data: { status: 'REJECTED', rejectedReason: reason, completedAt: at },
    });
    return count === 1;
  }
  async findReconcilable(olderThan: Date, limit: number): Promise<File[]> {
    return this.client.file.findMany({
      where: { status: { in: ['PENDING', 'UPLOADED'] }, createdAt: { lt: olderThan } },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
  }
  async markExpired(id: string): Promise<boolean> {
    const { count } = await this.client.file.updateMany({
      where: { id, status: { in: ['PENDING', 'UPLOADED'] } },
      data: { status: 'EXPIRED' },
    });
    return count === 1;
  }
  async softDelete(id: string, deletedAt: Date, tx: TransactionClient): Promise<boolean> {
    const { count } = await tx.file.updateMany({
      where: { id, status: 'READY' },
      data: { status: 'DELETED', deletedAt },
    });
    return count === 1;
  }
  async markSuperseded(id: string, replacementId: string, tx: TransactionClient): Promise<boolean> {
    const { count } = await tx.file.updateMany({
      where: { id, status: 'READY' },
      data: { status: 'SUPERSEDED', supersededById: replacementId },
    });
    return count === 1;
  }
  async findSweepable(now: Date, limit: number): Promise<File[]> {
    return this.client.file.findMany({
      where: { status: { in: ['PENDING', 'UPLOADED', 'EXPIRED'] }, uploadExpiresAt: { lt: now } },
      orderBy: { uploadExpiresAt: 'asc' },
      take: limit,
    });
  }
  async deleteReservation(id: string): Promise<boolean> {
    const { count } = await this.client.file.deleteMany({
      where: { id, status: { in: ['PENDING', 'UPLOADED', 'EXPIRED'] } },
    });
    return count === 1;
  }
  async findRetainable(
    due: readonly {
      purpose: FilePurpose;
      closedBefore: Date;
    }[],
    limit: number,
  ): Promise<File[]> {
    if (due.length === 0) return [];
    return this.client.file.findMany({
      where: {
        erasedAt: null,
        archivedAt: null,
        OR: due.map(({ purpose, closedBefore }) => ({
          purpose,
          OR: [
            { deletedAt: { lte: closedBefore } },
            { status: 'SUPERSEDED' as const, updatedAt: { lte: closedBefore } },
          ],
        })),
      },
      orderBy: { updatedAt: 'asc' },
      take: limit,
    });
  }
  async markRetired(
    id: string,
    outcome: 'ARCHIVED' | 'ERASED',
    at: Date,
    tx: TransactionClient,
  ): Promise<boolean> {
    const { count } = await tx.file.updateMany({
      where: { id, archivedAt: null, erasedAt: null },
      data: outcome === 'ARCHIVED' ? { archivedAt: at } : { erasedAt: at },
    });
    return count === 1;
  }
  async countPending(): Promise<number> {
    return this.client.file.count({ where: { status: 'PENDING' } });
  }
  async countAwaitingRetention(): Promise<number> {
    return this.client.file.count({
      where: {
        erasedAt: null,
        archivedAt: null,
        OR: [{ deletedAt: { not: null } }, { status: 'SUPERSEDED' }],
      },
    });
  }
  async storageByPurpose(): Promise<
    {
      purpose: FilePurpose;
      files: number;
      bytes: number;
    }[]
  > {
    const grouped = await this.client.file.groupBy({
      by: ['purpose'],
      where: { status: 'READY', deletedAt: null },
      _count: { _all: true },
      _sum: { sizeBytes: true },
    });
    return grouped.map((row) => ({
      purpose: row.purpose,
      files: row._count._all,
      bytes: row._sum.sizeBytes ?? 0,
    }));
  }
  async totalBytesForUser(ownerUserId: string, purpose?: FilePurpose): Promise<number> {
    const result = await this.client.file.aggregate({
      where: {
        ownerUserId,
        deletedAt: null,
        status: { in: ['PENDING', 'READY'] },
        ...(purpose ? { purpose } : {}),
      },
      _sum: { sizeBytes: true },
    });
    return result._sum.sizeBytes ?? 0;
  }
}
