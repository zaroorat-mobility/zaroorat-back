import { DatabaseService } from '@core/database';
import { Prisma } from '../../../generated/prisma/index.js';
import { FareRuleConflictError, FareRuleNotFoundError } from './pricing.errors.js';
import type { CreateFareRuleBody, ListFareRulesQuery, UpdateFareRuleBody } from './fare.schemas.js';

const UI_TO_CODE: Record<string, string> = {
  cab: 'CAB_ECONOMY',
  auto: 'AUTO',
  bike: 'BIKE',
  CAB_ECONOMY: 'CAB_ECONOMY',
  AUTO: 'AUTO',
  BIKE: 'BIKE',
};

const CODE_TO_UI: Record<string, 'cab' | 'auto' | 'bike'> = {
  CAB_ECONOMY: 'cab',
  CAB_PREMIUM: 'cab',
  AUTO: 'auto',
  BIKE: 'bike',
};

export interface FareRuleDto {
  id: string;
  ruleName: string;
  version: number;
  vehicleType: 'cab' | 'auto' | 'bike';
  vehicleTypeCode: string;
  cityCode: string;
  baseFare: number;
  minimumFare: number;
  perKmRate: number;
  perMinuteRate: number;
  freeWaitingMinutes: number;
  waitingChargePerMinute: number;
  nightEnabled: boolean;
  nightChargePercentage: number;
  status: 'active' | 'inactive';
  effectiveFrom: string;
  effectiveTo?: string;
  createdAt: string;
  updatedAt: string;
}

function toNum(value: { toString(): string } | number): number {
  return typeof value === 'number' ? value : Number(value.toString());
}

function nightPctFromMultiplier(multiplier: number): number {
  return Math.round(Math.max(0, (multiplier - 1) * 100));
}

function nightMultiplierFromInput(body: {
  nightEnabled?: boolean;
  nightChargePercentage?: number;
}): number {
  if (!body.nightEnabled) return 1;
  const pct = body.nightChargePercentage ?? 0;
  return 1 + pct / 100;
}

export class AdminFareService {
  constructor(private readonly databaseService: DatabaseService) {}

  async list(query: ListFareRulesQuery): Promise<{
    data: FareRuleDto[];
    meta: { currentPage: number; totalPages: number; pageSize: number; totalCount: number };
  }> {
    const where: Prisma.PricingRuleWhereInput = {};
    if (query.status === 'active') where.isActive = true;
    if (query.status === 'inactive') where.isActive = false;

    const rows = await this.databaseService.client.pricingRule.findMany({
      where,
      include: { vehicleType: true },
      orderBy: [{ createdAt: 'desc' }],
    });

    let data = rows.map((row) => this.toDto(row));
    if (query.search) {
      const q = query.search.toLowerCase();
      data = data.filter(
        (row) =>
          row.ruleName.toLowerCase().includes(q) ||
          row.vehicleTypeCode.toLowerCase().includes(q) ||
          row.cityCode.toLowerCase().includes(q),
      );
    }

    const totalCount = data.length;
    const skip = (query.page - 1) * query.limit;
    const pageRows = data.slice(skip, skip + query.limit);

    return {
      data: pageRows,
      meta: {
        currentPage: query.page,
        totalPages: Math.max(1, Math.ceil(totalCount / query.limit)),
        pageSize: query.limit,
        totalCount,
      },
    };
  }

  async getById(id: string): Promise<FareRuleDto> {
    const row = await this.databaseService.client.pricingRule.findUnique({
      where: { id },
      include: { vehicleType: true },
    });
    if (!row) throw new FareRuleNotFoundError();
    return this.toDto(row);
  }

  async create(body: CreateFareRuleBody, actorId?: string): Promise<FareRuleDto> {
    const vehicleType = await this.resolveVehicleType(body.vehicleType);
    const isActive = body.status !== 'inactive';
    const cityCode = body.cityCode || 'GLOBAL';

    if (isActive) {
      await this.databaseService.client.pricingRule.updateMany({
        where: { vehicleTypeId: vehicleType.id, cityCode, isActive: true },
        data: { isActive: false },
      });
    }

    const created = await this.databaseService.client.pricingRule.create({
      data: {
        vehicleTypeId: vehicleType.id,
        cityCode,
        baseFare: body.baseFare,
        minimumFare: body.minimumFare,
        perKmRate: body.perKmRate,
        perMinuteRate: body.perMinuteRate,
        freeWaitingMin: body.freeWaitingMinutes,
        waitingPerMin: body.waitingChargePerMinute,
        nightMultiplier: nightMultiplierFromInput({
          ...(body.nightEnabled !== undefined ? { nightEnabled: body.nightEnabled } : {}),
          ...(body.nightChargePercentage !== undefined
            ? { nightChargePercentage: body.nightChargePercentage }
            : {}),
        }),
        version: 1,
        isActive,
        effectiveFrom: new Date(body.effectiveFrom),
        ...(body.effectiveTo ? { effectiveTo: new Date(body.effectiveTo) } : {}),
        ...(actorId ? { createdBy: actorId } : {}),
      },
      include: { vehicleType: true },
    });

    return this.toDto(created);
  }

  async update(id: string, body: UpdateFareRuleBody, actorId?: string): Promise<FareRuleDto> {
    const existing = await this.databaseService.client.pricingRule.findUnique({
      where: { id },
      include: { vehicleType: true },
    });
    if (!existing) throw new FareRuleNotFoundError();

    const vehicleTypeCode = body.vehicleType
      ? (UI_TO_CODE[body.vehicleType] ?? body.vehicleType)
      : existing.vehicleType.code;
    const vehicleType = await this.resolveVehicleType(vehicleTypeCode);
    const cityCode = body.cityCode ?? existing.cityCode;
    const isActive = body.status !== undefined ? body.status === 'active' : existing.isActive;

    await this.databaseService.client.pricingRule.update({
      where: { id },
      data: { isActive: false },
    });

    if (isActive) {
      await this.databaseService.client.pricingRule.updateMany({
        where: {
          vehicleTypeId: vehicleType.id,
          cityCode,
          isActive: true,
          NOT: { id },
        },
        data: { isActive: false },
      });
    }

    const created = await this.databaseService.client.pricingRule.create({
      data: {
        vehicleTypeId: vehicleType.id,
        cityCode,
        baseFare: body.baseFare ?? toNum(existing.baseFare),
        minimumFare: body.minimumFare ?? toNum(existing.minimumFare),
        perKmRate: body.perKmRate ?? toNum(existing.perKmRate),
        perMinuteRate: body.perMinuteRate ?? toNum(existing.perMinuteRate),
        freeWaitingMin: body.freeWaitingMinutes ?? existing.freeWaitingMin,
        waitingPerMin: body.waitingChargePerMinute ?? toNum(existing.waitingPerMin),
        nightMultiplier:
          body.nightEnabled !== undefined || body.nightChargePercentage !== undefined
            ? nightMultiplierFromInput({
                nightEnabled: body.nightEnabled ?? toNum(existing.nightMultiplier) > 1,
                nightChargePercentage:
                  body.nightChargePercentage ??
                  nightPctFromMultiplier(toNum(existing.nightMultiplier)),
              })
            : existing.nightMultiplier,
        version: existing.version + 1,
        isActive,
        effectiveFrom: body.effectiveFrom ? new Date(body.effectiveFrom) : existing.effectiveFrom,
        ...(body.effectiveTo
          ? { effectiveTo: new Date(body.effectiveTo) }
          : existing.effectiveTo
            ? { effectiveTo: existing.effectiveTo }
            : {}),
        ...(actorId ? { createdBy: actorId } : {}),
      },
      include: { vehicleType: true },
    });

    return this.toDto(created);
  }

  async activate(id: string): Promise<FareRuleDto> {
    const existing = await this.databaseService.client.pricingRule.findUnique({
      where: { id },
      include: { vehicleType: true },
    });
    if (!existing) throw new FareRuleNotFoundError();

    await this.databaseService.client.pricingRule.updateMany({
      where: {
        vehicleTypeId: existing.vehicleTypeId,
        cityCode: existing.cityCode,
        isActive: true,
      },
      data: { isActive: false },
    });

    const updated = await this.databaseService.client.pricingRule.update({
      where: { id },
      data: { isActive: true },
      include: { vehicleType: true },
    });
    return this.toDto(updated);
  }

  async deactivate(id: string): Promise<FareRuleDto> {
    const existing = await this.databaseService.client.pricingRule.findUnique({
      where: { id },
    });
    if (!existing) throw new FareRuleNotFoundError();

    const updated = await this.databaseService.client.pricingRule.update({
      where: { id },
      data: { isActive: false },
      include: { vehicleType: true },
    });
    return this.toDto(updated);
  }

  async remove(id: string): Promise<void> {
    await this.deactivate(id);
  }

  private async resolveVehicleType(raw: string) {
    const code = UI_TO_CODE[raw] ?? raw.toUpperCase();
    const vehicleType = await this.databaseService.client.vehicleType.findUnique({
      where: { code },
    });
    if (!vehicleType) {
      throw new FareRuleConflictError(`Vehicle type ${code} is not configured`);
    }
    return vehicleType;
  }

  private toDto(row: {
    id: string;
    cityCode: string;
    baseFare: { toString(): string };
    minimumFare: { toString(): string };
    perKmRate: { toString(): string };
    perMinuteRate: { toString(): string };
    freeWaitingMin: number;
    waitingPerMin: { toString(): string };
    nightMultiplier: { toString(): string };
    version: number;
    isActive: boolean;
    effectiveFrom: Date;
    effectiveTo: Date | null;
    createdAt: Date;
    vehicleType: { code: string };
  }): FareRuleDto {
    const nightMultiplier = toNum(row.nightMultiplier);
    const nightPct = nightPctFromMultiplier(nightMultiplier);
    const uiType = CODE_TO_UI[row.vehicleType.code] ?? 'cab';
    return {
      id: row.id,
      ruleName: `${row.vehicleType.code} · ${row.cityCode}`,
      version: row.version,
      vehicleType: uiType,
      vehicleTypeCode: row.vehicleType.code,
      cityCode: row.cityCode,
      baseFare: toNum(row.baseFare),
      minimumFare: toNum(row.minimumFare),
      perKmRate: toNum(row.perKmRate),
      perMinuteRate: toNum(row.perMinuteRate),
      freeWaitingMinutes: row.freeWaitingMin,
      waitingChargePerMinute: toNum(row.waitingPerMin),
      nightEnabled: nightMultiplier > 1,
      nightChargePercentage: nightPct,
      status: row.isActive ? 'active' : 'inactive',
      effectiveFrom: row.effectiveFrom.toISOString().slice(0, 10),
      ...(row.effectiveTo ? { effectiveTo: row.effectiveTo.toISOString().slice(0, 10) } : {}),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.createdAt.toISOString(),
    };
  }
}
