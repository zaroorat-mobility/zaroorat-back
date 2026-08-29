import { DatabaseService } from '@core/database';
import { Prisma } from '../../../generated/prisma/index.js';
import { generateUniqueCode } from './code.util.js';
import { PromotionConflictError, PromotionNotFoundError } from './promotions.errors.js';
import type { CreatePromotionBody, ListPromotionsQuery, UpdatePromotionBody } from './schemas.js';

function toNum(value: { toString(): string } | number | null | undefined): number | null {
  if (value == null) return null;
  return typeof value === 'number' ? value : Number(value.toString());
}

function normalizeDiscountType(raw: string): 'PERCENT' | 'FIXED' {
  const upper = raw.trim().toUpperCase();
  if (upper === 'PERCENT' || upper === 'PERCENTAGE') return 'PERCENT';
  return 'FIXED';
}

export interface PromotionDto {
  id: string;
  code: string;
  title: string | null;
  description: string | null;
  discountType: 'PERCENT' | 'FIXED';
  discountValue: number;
  maxDiscount: number | null;
  minFare: number;
  applicableCity: string | null;
  applicableVehicleTypeId: string | null;
  firstRideOnly: boolean;
  usageLimitTotal: number | null;
  usageLimitPerUser: number | null;
  usedCount: number;
  validFrom: string;
  validTo: string;
  isActive: boolean;
  status: 'active' | 'inactive';
  createdAt: string;
}

export class AdminPromotionService {
  constructor(private readonly databaseService: DatabaseService) {}

  private toDto(row: {
    id: string;
    code: string;
    title: string | null;
    description: string | null;
    discountType: string;
    discountValue: { toString(): string };
    maxDiscount: { toString(): string } | null;
    minFare: { toString(): string };
    applicableCity: string | null;
    applicableVehicleType: string | null;
    firstRideOnly: boolean;
    usageLimitTotal: number | null;
    usageLimitPerUser: number | null;
    usedCount: number;
    validFrom: Date;
    validTo: Date;
    isActive: boolean;
    createdAt: Date;
  }): PromotionDto {
    return {
      id: row.id,
      code: row.code,
      title: row.title,
      description: row.description,
      discountType: normalizeDiscountType(row.discountType),
      discountValue: toNum(row.discountValue) ?? 0,
      maxDiscount: toNum(row.maxDiscount),
      minFare: toNum(row.minFare) ?? 0,
      applicableCity: row.applicableCity,
      applicableVehicleTypeId: row.applicableVehicleType,
      firstRideOnly: row.firstRideOnly,
      usageLimitTotal: row.usageLimitTotal,
      usageLimitPerUser: row.usageLimitPerUser,
      usedCount: row.usedCount,
      validFrom: row.validFrom.toISOString(),
      validTo: row.validTo.toISOString(),
      isActive: row.isActive,
      status: row.isActive ? 'active' : 'inactive',
      createdAt: row.createdAt.toISOString(),
    };
  }

  async list(query: ListPromotionsQuery): Promise<{
    data: PromotionDto[];
    meta: { currentPage: number; totalPages: number; pageSize: number; totalCount: number };
  }> {
    const where: Prisma.PromotionWhereInput = {};
    if (query.status === 'active') where.isActive = true;
    if (query.status === 'inactive') where.isActive = false;
    if (query.search) {
      where.OR = [
        { code: { contains: query.search, mode: 'insensitive' } },
        { title: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const totalCount = await this.databaseService.client.promotion.count({ where });
    const rows = await this.databaseService.client.promotion.findMany({
      where,
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

  async getById(id: string): Promise<PromotionDto> {
    const row = await this.databaseService.client.promotion.findUnique({ where: { id } });
    if (!row) throw new PromotionNotFoundError();
    return this.toDto(row);
  }

  async create(body: CreatePromotionBody): Promise<PromotionDto> {
    let code = body.code?.trim().toUpperCase();
    if (!code) {
      code = generateUniqueCode(body.title, 'PROMO');
    }
    const existing = await this.databaseService.client.promotion.findUnique({ where: { code } });
    if (existing) {
      if (body.code) {
        throw new PromotionConflictError(`Promotion code "${code}" already exists`);
      }
      code = generateUniqueCode(body.title, 'PROMO');
    }

    if (body.applicableVehicleTypeId) {
      const vt = await this.databaseService.client.vehicleType.findUnique({
        where: { id: body.applicableVehicleTypeId },
      });
      if (!vt) throw new PromotionConflictError('Vehicle type was not found');
    }

    const row = await this.databaseService.client.promotion.create({
      data: {
        code,
        title: body.title ?? null,
        description: body.description ?? null,
        discountType: normalizeDiscountType(body.discountType),
        discountValue: body.discountValue,
        maxDiscount: body.maxDiscount ?? null,
        minFare: body.minFare ?? 0,
        applicableCity: body.applicableCity ?? null,
        applicableVehicleType: body.applicableVehicleTypeId ?? null,
        firstRideOnly: body.firstRideOnly ?? false,
        usageLimitTotal: body.usageLimitTotal ?? null,
        usageLimitPerUser: body.usageLimitPerUser ?? 1,
        validFrom: body.validFrom,
        validTo: body.validTo,
        isActive: body.isActive ?? true,
      },
    });
    return this.toDto(row);
  }

  async update(id: string, body: UpdatePromotionBody): Promise<PromotionDto> {
    const existing = await this.databaseService.client.promotion.findUnique({ where: { id } });
    if (!existing) throw new PromotionNotFoundError();

    if (body.code) {
      const code = body.code.trim().toUpperCase();
      const clash = await this.databaseService.client.promotion.findFirst({
        where: { code, id: { not: id } },
      });
      if (clash) throw new PromotionConflictError(`Promotion code "${code}" already exists`);
    }

    const row = await this.databaseService.client.promotion.update({
      where: { id },
      data: {
        ...(body.code !== undefined ? { code: body.code.trim().toUpperCase() } : {}),
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.discountType !== undefined
          ? { discountType: normalizeDiscountType(body.discountType) }
          : {}),
        ...(body.discountValue !== undefined ? { discountValue: body.discountValue } : {}),
        ...(body.maxDiscount !== undefined ? { maxDiscount: body.maxDiscount } : {}),
        ...(body.minFare !== undefined ? { minFare: body.minFare } : {}),
        ...(body.applicableCity !== undefined ? { applicableCity: body.applicableCity } : {}),
        ...(body.applicableVehicleTypeId !== undefined
          ? { applicableVehicleType: body.applicableVehicleTypeId }
          : {}),
        ...(body.firstRideOnly !== undefined ? { firstRideOnly: body.firstRideOnly } : {}),
        ...(body.usageLimitTotal !== undefined ? { usageLimitTotal: body.usageLimitTotal } : {}),
        ...(body.usageLimitPerUser !== undefined
          ? { usageLimitPerUser: body.usageLimitPerUser }
          : {}),
        ...(body.validFrom !== undefined ? { validFrom: body.validFrom } : {}),
        ...(body.validTo !== undefined ? { validTo: body.validTo } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
      },
    });
    return this.toDto(row);
  }

  async activate(id: string): Promise<PromotionDto> {
    return this.update(id, { isActive: true });
  }

  async deactivate(id: string): Promise<PromotionDto> {
    return this.update(id, { isActive: false });
  }
}
