import { DatabaseService } from '@core/database';
import { Prisma } from '../../../generated/prisma/index.js';
import { ReferralNotFoundError } from './referral.errors.js';
import type { ListReferralsQuery } from './schemas.js';

function toNum(value: { toString(): string } | number | null | undefined): number | null {
  if (value == null) return null;
  return typeof value === 'number' ? value : Number(value.toString());
}

export interface ReferralRewardDto {
  id: string;
  beneficiary: string;
  userId: string;
  amount: number;
  rewardType: string;
  status: string;
  creditedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface ReferralHistoryDto {
  id: string;
  programId: string;
  programCode: string;
  referrerId: string;
  referrerEmail: string | null;
  referrerPhone: string | null;
  refereeId: string | null;
  refereeEmail: string | null;
  refereePhone: string | null;
  referralCode: string | null;
  status: string;
  qualifyingRides: number;
  signedUpAt: string | null;
  qualifiedAt: string | null;
  rewardedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  rewards: ReferralRewardDto[];
}

export class AdminReferralHistoryService {
  constructor(private readonly databaseService: DatabaseService) {}

  private toDto(row: {
    id: string;
    programId: string;
    referrerId: string;
    refereeId: string | null;
    status: string;
    qualifyingRides: number;
    signedUpAt: Date | null;
    qualifiedAt: Date | null;
    rewardedAt: Date | null;
    expiresAt: Date | null;
    createdAt: Date;
    program?: { code: string };
    referrer?: { email: string | null; phoneNumber: string };
    referee?: { email: string | null; phoneNumber: string } | null;
    referralCode?: { code: string } | null;
    rewards?: Array<{
      id: string;
      beneficiary: string;
      userId: string;
      amount: { toString(): string };
      rewardType: string;
      status: string;
      creditedAt: Date | null;
      expiresAt: Date | null;
      createdAt: Date;
    }>;
  }): ReferralHistoryDto {
    return {
      id: row.id,
      programId: row.programId,
      programCode: row.program?.code ?? '',
      referrerId: row.referrerId,
      referrerEmail: row.referrer?.email ?? null,
      referrerPhone: row.referrer?.phoneNumber ?? null,
      refereeId: row.refereeId,
      refereeEmail: row.referee?.email ?? null,
      refereePhone: row.referee?.phoneNumber ?? null,
      referralCode: row.referralCode?.code ?? null,
      status: row.status,
      qualifyingRides: row.qualifyingRides,
      signedUpAt: row.signedUpAt?.toISOString() ?? null,
      qualifiedAt: row.qualifiedAt?.toISOString() ?? null,
      rewardedAt: row.rewardedAt?.toISOString() ?? null,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      rewards: (row.rewards ?? []).map((r) => ({
        id: r.id,
        beneficiary: r.beneficiary,
        userId: r.userId,
        amount: toNum(r.amount) ?? 0,
        rewardType: r.rewardType,
        status: r.status,
        creditedAt: r.creditedAt?.toISOString() ?? null,
        expiresAt: r.expiresAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  }

  private include = {
    program: true,
    referrer: true,
    referee: true,
    referralCode: true,
    rewards: true,
  } as const;

  async list(query: ListReferralsQuery): Promise<{
    data: ReferralHistoryDto[];
    meta: { currentPage: number; totalPages: number; pageSize: number; totalCount: number };
  }> {
    const where: Prisma.ReferralWhereInput = {};
    if (query.status !== 'all') where.status = query.status;
    if (query.programId) where.programId = query.programId;
    if (query.search) {
      where.OR = [
        { referralCode: { code: { contains: query.search, mode: 'insensitive' } } },
        { referrer: { email: { contains: query.search, mode: 'insensitive' } } },
        { referee: { email: { contains: query.search, mode: 'insensitive' } } },
        { program: { code: { contains: query.search, mode: 'insensitive' } } },
      ];
    }

    const totalCount = await this.databaseService.client.referral.count({ where });
    const rows = await this.databaseService.client.referral.findMany({
      where,
      include: this.include,
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

  async getById(id: string): Promise<ReferralHistoryDto> {
    const row = await this.databaseService.client.referral.findUnique({
      where: { id },
      include: this.include,
    });
    if (!row) throw new ReferralNotFoundError();
    return this.toDto(row);
  }
}
