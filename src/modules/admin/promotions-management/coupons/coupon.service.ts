import { randomBytes } from 'node:crypto';
import { DatabaseService } from '@core/database';
import { Prisma } from '../../../../generated/prisma/index.js';
import {
  CampaignNotFoundError,
  CouponBatchExhaustedError,
  CouponBatchNotFoundError,
  PromotionNotFoundError,
} from '../promotions.errors.js';
import type {
  CreateCouponBatchBody,
  GenerateCouponsBody,
  ListCouponBatchesQuery,
  ListCouponsQuery,
} from '../schemas.js';

function randomSuffix(len = 8): string {
  return randomBytes(Math.ceil(len / 2))
    .toString('hex')
    .slice(0, len)
    .toUpperCase();
}

export interface CouponBatchDto {
  id: string;
  campaignId: string | null;
  promotionId: string;
  promotionCode: string;
  name: string | null;
  prefix: string | null;
  totalCount: number;
  generatedCount: number;
  perUserLimit: number;
  expiresAt: string | null;
  isActive: boolean;
  status: 'active' | 'inactive';
  createdAt: string;
}

export interface CouponDto {
  id: string;
  batchId: string;
  code: string;
  userId: string | null;
  status: string;
  redeemedRideId: string | null;
  assignedAt: string | null;
  redeemedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export class AdminCouponService {
  constructor(private readonly databaseService: DatabaseService) {}

  private toBatchDto(row: {
    id: string;
    campaignId: string | null;
    promotionId: string;
    name: string | null;
    prefix: string | null;
    totalCount: number;
    generatedCount: number;
    perUserLimit: number;
    expiresAt: Date | null;
    isActive: boolean;
    createdAt: Date;
    promotion?: { code: string };
  }): CouponBatchDto {
    return {
      id: row.id,
      campaignId: row.campaignId,
      promotionId: row.promotionId,
      promotionCode: row.promotion?.code ?? '',
      name: row.name,
      prefix: row.prefix,
      totalCount: row.totalCount,
      generatedCount: row.generatedCount,
      perUserLimit: row.perUserLimit,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      isActive: row.isActive,
      status: row.isActive ? 'active' : 'inactive',
      createdAt: row.createdAt.toISOString(),
    };
  }

  private toCouponDto(row: {
    id: string;
    batchId: string;
    code: string;
    userId: string | null;
    status: string;
    redeemedRideId: string | null;
    assignedAt: Date | null;
    redeemedAt: Date | null;
    expiresAt: Date | null;
    createdAt: Date;
  }): CouponDto {
    return {
      id: row.id,
      batchId: row.batchId,
      code: row.code,
      userId: row.userId,
      status: row.status,
      redeemedRideId: row.redeemedRideId,
      assignedAt: row.assignedAt?.toISOString() ?? null,
      redeemedAt: row.redeemedAt?.toISOString() ?? null,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async listBatches(query: ListCouponBatchesQuery): Promise<{
    data: CouponBatchDto[];
    meta: { currentPage: number; totalPages: number; pageSize: number; totalCount: number };
  }> {
    const where: Prisma.CouponBatchWhereInput = {};
    if (query.status === 'active') where.isActive = true;
    if (query.status === 'inactive') where.isActive = false;
    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { prefix: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const totalCount = await this.databaseService.client.couponBatch.count({ where });
    const rows = await this.databaseService.client.couponBatch.findMany({
      where,
      include: { promotion: true },
      orderBy: { createdAt: 'desc' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });

    return {
      data: rows.map((r) => this.toBatchDto(r)),
      meta: {
        currentPage: query.page,
        totalPages: Math.max(1, Math.ceil(totalCount / query.limit)),
        pageSize: query.limit,
        totalCount,
      },
    };
  }

  async getBatch(id: string): Promise<CouponBatchDto> {
    const row = await this.databaseService.client.couponBatch.findUnique({
      where: { id },
      include: { promotion: true },
    });
    if (!row) throw new CouponBatchNotFoundError();
    return this.toBatchDto(row);
  }

  async createBatch(body: CreateCouponBatchBody): Promise<CouponBatchDto> {
    const promotion = await this.databaseService.client.promotion.findUnique({
      where: { id: body.promotionId },
    });
    if (!promotion) throw new PromotionNotFoundError();

    if (body.campaignId) {
      const campaign = await this.databaseService.client.promoCampaign.findUnique({
        where: { id: body.campaignId },
      });
      if (!campaign) throw new CampaignNotFoundError();
    }

    const batch = await this.databaseService.client.couponBatch.create({
      data: {
        promotionId: body.promotionId,
        campaignId: body.campaignId ?? null,
        name: body.name ?? null,
        prefix: body.prefix?.trim().toUpperCase() ?? null,
        totalCount: body.totalCount,
        generatedCount: 0,
        perUserLimit: body.perUserLimit ?? 1,
        expiresAt: body.expiresAt ?? null,
        isActive: body.isActive ?? true,
      },
      include: { promotion: true },
    });

    if (body.generateNow !== false) {
      await this.generateCoupons(batch.id, { count: body.totalCount });
      return this.getBatch(batch.id);
    }

    return this.toBatchDto(batch);
  }

  async generateCoupons(batchId: string, body: GenerateCouponsBody): Promise<CouponBatchDto> {
    const batch = await this.databaseService.client.couponBatch.findUnique({
      where: { id: batchId },
    });
    if (!batch) throw new CouponBatchNotFoundError();

    // FR-019. `remaining || body.count` collapsed to `body.count` the moment the
    // batch was exhausted, because 0 is falsy — so the guard read
    // `Math.min(count, count)` and generation became unlimited. Line 221 then
    // raised `totalCount` to match, erasing the evidence that a cap had ever
    // been exceeded. Repeated POSTs to /generate minted unbounded coupons
    // against a promotion.
    const remaining = Math.max(0, batch.totalCount - batch.generatedCount);
    if (remaining === 0) {
      throw new CouponBatchExhaustedError(
        `Batch has already generated all ${batch.totalCount} of its coupons`,
      );
    }
    const toCreate = Math.min(body.count, remaining);
    const prefix = (batch.prefix ?? 'CPN').toUpperCase();
    const codes: string[] = [];

    for (let i = 0; i < toCreate; i++) {
      codes.push(`${prefix}${randomSuffix(8)}`);
    }

    await this.databaseService.transactionManager.execute(async (tx) => {
      await tx.coupon.createMany({
        data: codes.map((code) => ({
          batchId,
          code,
          status: 'ACTIVE' as const,
          expiresAt: batch.expiresAt,
        })),
        skipDuplicates: true,
      });
      const generated = await tx.coupon.count({ where: { batchId } });
      await tx.couponBatch.update({
        where: { id: batchId },
        data: {
          generatedCount: generated,
          // `totalCount` is the cap an operator set, not a running tally. Raising
          // it to match whatever was generated made the cap unenforceable and
          // hid that it had been breached.
        },
      });
    });

    return this.getBatch(batchId);
  }

  async listCoupons(query: ListCouponsQuery): Promise<{
    data: CouponDto[];
    meta: { currentPage: number; totalPages: number; pageSize: number; totalCount: number };
  }> {
    const where: Prisma.CouponWhereInput = {};
    if (query.batchId) where.batchId = query.batchId;
    if (query.status !== 'all') where.status = query.status;
    if (query.search) {
      where.code = { contains: query.search, mode: 'insensitive' };
    }

    const totalCount = await this.databaseService.client.coupon.count({ where });
    const rows = await this.databaseService.client.coupon.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });

    return {
      data: rows.map((r) => this.toCouponDto(r)),
      meta: {
        currentPage: query.page,
        totalPages: Math.max(1, Math.ceil(totalCount / query.limit)),
        pageSize: query.limit,
        totalCount,
      },
    };
  }

  async activateBatch(id: string): Promise<CouponBatchDto> {
    const existing = await this.databaseService.client.couponBatch.findUnique({ where: { id } });
    if (!existing) throw new CouponBatchNotFoundError();
    const row = await this.databaseService.client.couponBatch.update({
      where: { id },
      data: { isActive: true },
      include: { promotion: true },
    });
    return this.toBatchDto(row);
  }

  async deactivateBatch(id: string): Promise<CouponBatchDto> {
    const existing = await this.databaseService.client.couponBatch.findUnique({ where: { id } });
    if (!existing) throw new CouponBatchNotFoundError();
    const row = await this.databaseService.client.couponBatch.update({
      where: { id },
      data: { isActive: false },
      include: { promotion: true },
    });
    return this.toBatchDto(row);
  }
}
