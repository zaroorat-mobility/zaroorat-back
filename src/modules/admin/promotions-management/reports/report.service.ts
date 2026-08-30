import { DatabaseService } from '@core/database';
import { Prisma } from '../../../../generated/prisma/index.js';
import { PromotionNotFoundError } from '../promotions.errors.js';
import type { ReportOverviewQuery } from '../schemas.js';

function toNum(value: { toString(): string } | number | null | undefined): number {
  if (value == null) return 0;
  return typeof value === 'number' ? value : Number(value.toString());
}

export interface ReportOverviewDto {
  totalUsage: number;
  totalDiscountAmount: number;
  revenueImpact: number;
  uniqueUsers: number;
  activePromotions: number;
  promotions: Array<{
    id: string;
    code: string;
    title: string | null;
    usedCount: number;
    usageLimitTotal: number | null;
    discountAmount: number;
    uniqueUsers: number;
  }>;
}

export interface PromotionPerformanceDto {
  id: string;
  code: string;
  title: string | null;
  usedCount: number;
  usageLimitTotal: number | null;
  usageLimitPerUser: number | null;
  totalDiscountAmount: number;
  revenueImpact: number;
  uniqueUsers: number;
  redemptionRate: number | null;
  recentRedemptions: Array<{
    id: string;
    userId: string;
    rideId: string | null;
    discountAmount: number;
    redeemedAt: string;
  }>;
}

export class AdminPromoReportService {
  constructor(private readonly databaseService: DatabaseService) {}

  async overview(query: ReportOverviewQuery): Promise<ReportOverviewDto> {
    const where: Prisma.PromotionRedemptionWhereInput = {};
    if (query.from || query.to) {
      where.redeemedAt = {};
      if (query.from) where.redeemedAt.gte = query.from;
      if (query.to) where.redeemedAt.lte = query.to;
    }

    const [agg, uniqueUsers, activePromotions, byPromo] = await Promise.all([
      this.databaseService.client.promotionRedemption.aggregate({
        where,
        _count: { id: true },
        _sum: { discountAmount: true },
      }),
      this.databaseService.client.promotionRedemption.findMany({
        where,
        select: { userId: true },
        distinct: ['userId'],
      }),
      this.databaseService.client.promotion.count({ where: { isActive: true } }),
      this.databaseService.client.promotionRedemption.groupBy({
        by: ['promotionId'],
        where,
        _count: { id: true },
        _sum: { discountAmount: true },
      }),
    ]);

    const promoIds = byPromo.map((p) => p.promotionId);
    const promotions = promoIds.length
      ? await this.databaseService.client.promotion.findMany({
          where: { id: { in: promoIds } },
        })
      : [];
    const promoMap = new Map(promotions.map((p) => [p.id, p]));

    const uniqueByPromo = await Promise.all(
      byPromo.map(async (row) => {
        const users = await this.databaseService.client.promotionRedemption.findMany({
          where: { ...where, promotionId: row.promotionId },
          select: { userId: true },
          distinct: ['userId'],
        });
        return { promotionId: row.promotionId, uniqueUsers: users.length };
      }),
    );
    const uniqueMap = new Map(uniqueByPromo.map((u) => [u.promotionId, u.uniqueUsers]));

    const totalDiscountAmount = toNum(agg._sum.discountAmount);

    return {
      totalUsage: agg._count.id,
      totalDiscountAmount,
      revenueImpact: totalDiscountAmount,
      uniqueUsers: uniqueUsers.length,
      activePromotions,
      promotions: byPromo.map((row) => {
        const promo = promoMap.get(row.promotionId);
        return {
          id: row.promotionId,
          code: promo?.code ?? '',
          title: promo?.title ?? null,
          usedCount: row._count.id,
          usageLimitTotal: promo?.usageLimitTotal ?? null,
          discountAmount: toNum(row._sum.discountAmount),
          uniqueUsers: uniqueMap.get(row.promotionId) ?? 0,
        };
      }),
    };
  }

  async performance(id: string, query: ReportOverviewQuery): Promise<PromotionPerformanceDto> {
    const promo = await this.databaseService.client.promotion.findUnique({ where: { id } });
    if (!promo) throw new PromotionNotFoundError();

    const where: Prisma.PromotionRedemptionWhereInput = { promotionId: id };
    if (query.from || query.to) {
      where.redeemedAt = {};
      if (query.from) where.redeemedAt.gte = query.from;
      if (query.to) where.redeemedAt.lte = query.to;
    }

    const [agg, uniqueUsers, recent] = await Promise.all([
      this.databaseService.client.promotionRedemption.aggregate({
        where,
        _count: { id: true },
        _sum: { discountAmount: true },
      }),
      this.databaseService.client.promotionRedemption.findMany({
        where,
        select: { userId: true },
        distinct: ['userId'],
      }),
      this.databaseService.client.promotionRedemption.findMany({
        where,
        orderBy: { redeemedAt: 'desc' },
        take: 20,
      }),
    ]);

    const totalDiscountAmount = toNum(agg._sum.discountAmount);
    const usedCount = agg._count.id;

    return {
      id: promo.id,
      code: promo.code,
      title: promo.title,
      usedCount,
      usageLimitTotal: promo.usageLimitTotal,
      usageLimitPerUser: promo.usageLimitPerUser,
      totalDiscountAmount,
      revenueImpact: totalDiscountAmount,
      uniqueUsers: uniqueUsers.length,
      redemptionRate:
        promo.usageLimitTotal && promo.usageLimitTotal > 0
          ? Math.round((usedCount / promo.usageLimitTotal) * 10000) / 100
          : null,
      recentRedemptions: recent.map((r) => ({
        id: r.id,
        userId: r.userId,
        rideId: r.rideId,
        discountAmount: toNum(r.discountAmount),
        redeemedAt: r.redeemedAt.toISOString(),
      })),
    };
  }
}
