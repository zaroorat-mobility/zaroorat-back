import { DatabaseService } from '@core/database';
import { Prisma } from '../../../../generated/prisma/index.js';
import { lockForAudit, recordAdminAction, type AuditActor } from '../../audit/index.js';
import { ReferralCodeNotFoundError } from '../referral.errors.js';
import type { ListCodesQuery } from '../schemas.js';

export interface ReferralCodeDto {
  id: string;
  userId: string;
  userEmail: string | null;
  userPhone: string | null;
  programId: string;
  programCode: string;
  code: string;
  usesCount: number;
  maxUses: number | null;
  isActive: boolean;
  status: 'active' | 'inactive';
  createdAt: string;
}

export class AdminReferralCodeService {
  constructor(private readonly databaseService: DatabaseService) {}

  private toDto(row: {
    id: string;
    userId: string;
    programId: string;
    code: string;
    usesCount: number;
    maxUses: number | null;
    isActive: boolean;
    createdAt: Date;
    user?: { email: string | null; phoneNumber: string };
    program?: { code: string };
  }): ReferralCodeDto {
    return {
      id: row.id,
      userId: row.userId,
      userEmail: row.user?.email ?? null,
      userPhone: row.user?.phoneNumber ?? null,
      programId: row.programId,
      programCode: row.program?.code ?? '',
      code: row.code,
      usesCount: row.usesCount,
      maxUses: row.maxUses,
      isActive: row.isActive,
      status: row.isActive ? 'active' : 'inactive',
      createdAt: row.createdAt.toISOString(),
    };
  }

  async list(query: ListCodesQuery): Promise<{
    data: ReferralCodeDto[];
    meta: { currentPage: number; totalPages: number; pageSize: number; totalCount: number };
  }> {
    const where: Prisma.ReferralCodeWhereInput = {};
    if (query.status === 'active') where.isActive = true;
    if (query.status === 'inactive') where.isActive = false;
    if (query.programId) where.programId = query.programId;
    if (query.userId) where.userId = query.userId;
    if (query.audience) where.program = { audience: query.audience };
    if (query.search) {
      where.OR = [
        { code: { contains: query.search, mode: 'insensitive' } },
        { user: { email: { contains: query.search, mode: 'insensitive' } } },
        { user: { phoneNumber: { contains: query.search, mode: 'insensitive' } } },
      ];
    }

    const totalCount = await this.databaseService.client.referralCode.count({ where });
    const rows = await this.databaseService.client.referralCode.findMany({
      where,
      include: { user: true, program: true },
      orderBy: { createdAt: 'desc' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });

    return {
      data: rows.map((r) => this.toDto(r)),
      meta: {
        currentPage: query.page,
        totalPages: Math.max(1, Math.ceil(totalCount / query.limit)),
        pageSize: query.limit,
        totalCount,
      },
    };
  }

  async activate(id: string, actor: AuditActor): Promise<ReferralCodeDto> {
    return this.setActive(id, true, actor);
  }

  async deactivate(id: string, actor: AuditActor): Promise<ReferralCodeDto> {
    return this.setActive(id, false, actor);
  }

  /// The row carries its owner's `user` relation for the DTO; the audit names only the
  /// fields that changed and their keys, never that user record.
  private async setActive(
    id: string,
    isActive: boolean,
    actor: AuditActor,
  ): Promise<ReferralCodeDto> {
    return this.databaseService.transactionManager.execute(async (tx) => {
      await lockForAudit(tx, 'referral_codes', id);
      const existing = await tx.referralCode.findUnique({ where: { id } });
      if (!existing) throw new ReferralCodeNotFoundError();
      const row = await tx.referralCode.update({
        where: { id },
        data: { isActive },
        include: { user: true, program: true },
      });
      await recordAdminAction(tx, {
        ...actor,
        action: 'UPDATE',
        entityType: 'referral_code',
        entityId: id,
        summary: `Referral code ${row.code} ${isActive ? 'activated' : 'deactivated'}`,
        before: {
          isActive: existing.isActive,
          userId: existing.userId,
          programId: existing.programId,
        },
        after: { isActive: row.isActive, userId: row.userId, programId: row.programId },
        result: 'SUCCESS',
      });
      return this.toDto(row);
    });
  }
}
