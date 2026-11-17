import { DatabaseService } from '@core/database';
import { Prisma, type RideServiceType } from '../../../../generated/prisma/index.js';
import { recordAdminAction } from '../../audit/index.js';
import { FareRuleConflictError, FareRuleNotFoundError } from '../pricing.errors.js';
import type {
  CreateFareRuleBody,
  ListFareRulesQuery,
  PreviewFareRuleBody,
  UpdateFareRuleBody,
} from './fare.schemas.js';
import { PricingService } from '@modules/pricing';
import {
  AdminServiceZoneService,
  parseServiceType,
  serviceTypeUi,
} from '../service-zone/service-zone.service.js';
import {
  VehicleTypeService,
  vehicleTypeDisplayName,
} from '@modules/vehicles/services/vehicle-type.service.js';

export interface FareRuleDto {
  id: string;
  ruleName: string;
  version: number;
  /// The exact vehicle type code. This used to be a `cab | auto | bike` guess
  /// that called every cab variant "cab", so an edit form loaded from it could
  /// only post "cab" back and move a Cab Mini (AC) rule onto another type.
  vehicleType: string;
  vehicleTypeId: string;
  vehicleTypeCode: string;
  vehicleTypeName: string;
  /// The type's own `category` column (car, auto, bike) — for grouping only.
  vehicleCategory: string;
  cityCode: string;
  serviceType: string | null;
  serviceZoneId: string | null;
  serviceZoneName: string | null;
  baseFare: number;
  minimumFare: number;
  perKmRate: number;
  perMinuteRate: number;
  freeWaitingMinutes: number;
  waitingChargePerMinute: number;
  bookingFee: number;
  platformFeePct: number;
  platformFeeFlat: number | null;
  taxRatePct: number | null;
  commissionRatePct: number | null;
  status: 'active' | 'inactive';
  effectiveFrom: string;
  effectiveTo?: string;
  createdAt: string;
  updatedAt: string;
}

function toNum(value: { toString(): string } | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === 'number' ? value : Number(value.toString());
}

type RuleKey = {
  vehicleTypeId: string;
  cityCode: string;
  serviceType: RideServiceType | null;
  serviceZoneId: string | null;
};

/// FR-034. The application half of "one active rule per key".
///
/// It is only the application half. Two admins saving at once both read no
/// conflict, both deactivate nothing, and both insert an active rule — after
/// which `findBestActiveRule` picks whichever the index returns first and the
/// same journey can be quoted at two prices. The partial unique index added in
/// `20260829140000_pricing_rule_one_active` is what actually decides; this
/// clause is what keeps the common case from reaching it.
function exclusivityWhere(key: RuleKey): Prisma.PricingRuleWhereInput {
  return {
    vehicleTypeId: key.vehicleTypeId,
    cityCode: key.cityCode,
    serviceType: key.serviceType,
    serviceZoneId: key.serviceZoneId,
    isActive: true,
  };
}

/// FR-034. The database now refuses a second live rule whose effective window
/// overlaps an existing one on the same key. That is a 409 to the operator who
/// lost the race, not a 500: their save was rejected because someone else's
/// landed first, and retrying is the right response.
///
/// The rejection arrives as PostgreSQL's `23P01` (exclusion_violation), which
/// Prisma has no dedicated code for — it surfaces as a raw database error rather
/// than as `P2002`. Matching on the constraint name is what makes it
/// recognisable, and keeps an unrelated database failure a 500.
function rethrowOneActiveConflict(err: unknown): never {
  if (
    err instanceof Error &&
    /pricing_rules_one_in_force_(typed|untyped)|23P01/.test(
      `${err.message}${JSON.stringify((err as { meta?: unknown }).meta ?? '')}`,
    )
  ) {
    throw new FareRuleConflictError(
      'Another fare rule is already in force for this vehicle type, city, service type and zone over an overlapping period',
    );
  }
  throw err;
}

export class AdminFareService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly adminServiceZoneService: AdminServiceZoneService,
    private readonly vehicleTypeService: VehicleTypeService,
    private readonly pricingService: PricingService,
  ) {}

  /// The fare an unsaved rule would charge, priced by PricingService itself (rate card defaults,
  /// minimum fare, surge, discount, ceiling, tax, platform fee, driver earning). The admin
  /// preview used to price it in React with a different commission formula. Read-only.
  async preview(body: PreviewFareRuleBody) {
    const card = this.pricingService.rateCardFor({
      baseFare: body.baseFare,
      perKmRate: body.perKmRate,
      perMinuteRate: body.perMinuteRate,
      waitingPerMin: body.waitingChargePerMinute,
      freeWaitingMin: body.freeWaitingMinutes,
      bookingFee: body.bookingFee,
      platformFeePct: body.platformFeePct,
      platformFeeFlat: body.platformFeeFlat ?? null,
      taxRatePct: body.taxRatePct ?? null,
      commissionRatePct: body.commissionRatePct ?? null,
      minimumFare: body.minimumFare,
    });
    const trip = {
      actualDistanceKm: body.distanceKm,
      actualDurationMin: body.durationMin,
      // Unused when a rate card is given; a preview has no vehicle row of its own.
      vehicleTypeId: '',
      rateCard: card,
    };
    const fare = await this.pricingService.calculateFinalFare({
      ...trip,
      surgeMultiplier: body.surgeMultiplier,
      waitingMinutes: body.waitingMinutes,
      discountAmount: body.discountAmount,
      ...(body.fareCeiling !== undefined ? { fareCeiling: body.fareCeiling } : {}),
    });
    // What acceptance locks for a COMMISSION driver: the trip as quoted, no discount
    // (PricingService.estimatedCommission prices it the same way).
    const atAcceptance = await this.pricingService.calculateFinalFare(trip);
    return {
      fare,
      commissionAtAcceptance: atAcceptance.platformCommission,
      rates: {
        taxRatePct: card.taxRatePct,
        taxRateIsDefault: body.taxRatePct === undefined,
        commissionRatePct: card.commissionRatePct,
        commissionRateIsDefault: body.commissionRatePct === undefined,
      },
    };
  }

  /// The rates a rule inherits when it leaves them blank (environment configuration).
  platformDefaults() {
    const card = this.pricingService.rateCardFor(null);
    return {
      taxRatePct: card.taxRatePct,
      commissionRatePct: card.commissionRatePct,
      platformFeePct: card.platformFeePct,
      platformFeeFlat: card.platformFeeFlat,
    };
  }

  async list(query: ListFareRulesQuery): Promise<{
    data: FareRuleDto[];
    meta: { currentPage: number; totalPages: number; pageSize: number; totalCount: number };
  }> {
    const where: Prisma.PricingRuleWhereInput = {};
    if (query.status === 'active') where.isActive = true;
    if (query.status === 'inactive') where.isActive = false;
    if (query.cityCode) where.cityCode = query.cityCode;
    if (query.search) {
      // The searchable text lives across three tables, so the filter belongs in
      // the query. `ruleName` is not searched because it is not stored: `toDto`
      // composes it from the vehicle-type code, city code, service type and zone
      // name, and those are exactly the columns matched here.
      where.OR = [
        { cityCode: { contains: query.search, mode: 'insensitive' } },
        { vehicleType: { code: { contains: query.search, mode: 'insensitive' } } },
        { serviceZone: { name: { contains: query.search, mode: 'insensitive' } } },
      ];
    }

    /// FR-040. Every rule was loaded, mapped to a DTO, filtered in JavaScript and
    /// then sliced — so `?limit=1` still read the whole table, and `totalCount`
    /// was the size of an array the server had already built. Rule volume is
    /// small today, which is why nobody noticed; the endpoint is paginated so it
    /// stays that way as cities and zones multiply the row count.
    const [totalCount, rows] = await Promise.all([
      this.databaseService.client.pricingRule.count({ where }),
      this.databaseService.client.pricingRule.findMany({
        where,
        include: { vehicleType: true, serviceZone: true },
        orderBy: [{ createdAt: 'desc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
    ]);

    return {
      data: rows.map((row) => this.toDto(row)),
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
      include: { vehicleType: true, serviceZone: true },
    });
    if (!row) throw new FareRuleNotFoundError();
    return this.toDto(row);
  }

  async create(body: CreateFareRuleBody, actorId?: string): Promise<FareRuleDto> {
    const vehicleType = await this.vehicleTypeService.resolveForConfig({
      id: body.vehicleTypeId,
      code: body.vehicleType,
    });
    const isActive = body.status !== 'inactive';
    const cityCode = body.cityCode || 'GLOBAL';
    const serviceType = parseServiceType(body.serviceType ?? null);
    const serviceZoneId = body.serviceZoneId ?? null;

    if (serviceZoneId) {
      await this.adminServiceZoneService.assertZoneBelongsToCity(serviceZoneId, cityCode);
    }

    const key: RuleKey = {
      vehicleTypeId: vehicleType.id,
      cityCode,
      serviceType,
      serviceZoneId,
    };

    /// FR-034. Deactivating the incumbent and inserting its replacement is one
    /// change. Untransacted, a failure between them left the key with no active
    /// rule at all — and a key with no active rule does not fail loudly, it
    /// falls through to the GLOBAL card and quietly prices the city wrong.
    const created = await this.databaseService.transactionManager
      .execute(async (tx) => {
        if (isActive) {
          await tx.pricingRule.updateMany({
            where: exclusivityWhere(key),
            data: { isActive: false },
          });
        }

        const row = await tx.pricingRule.create({
          data: {
            vehicleTypeId: vehicleType.id,
            cityCode,
            serviceType,
            serviceZoneId,
            baseFare: body.baseFare,
            minimumFare: body.minimumFare,
            perKmRate: body.perKmRate,
            perMinuteRate: body.perMinuteRate,
            freeWaitingMin: body.freeWaitingMinutes,
            waitingPerMin: body.waitingChargePerMinute,
            bookingFee: body.bookingFee,
            platformFeePct: body.platformFeePct,
            ...(body.platformFeeFlat !== undefined
              ? { platformFeeFlat: body.platformFeeFlat }
              : {}),
            ...(body.taxRatePct !== undefined ? { taxRatePct: body.taxRatePct } : {}),
            ...(body.commissionRatePct !== undefined
              ? { commissionRatePct: body.commissionRatePct }
              : {}),
            version: 1,
            isActive,
            effectiveFrom: new Date(body.effectiveFrom),
            ...(body.effectiveTo ? { effectiveTo: new Date(body.effectiveTo) } : {}),
            ...(actorId ? { createdBy: actorId } : {}),
          },
          include: { vehicleType: true, serviceZone: true },
        });

        const dto = this.toDto(row);
        await recordAdminAction(tx, {
          actorId,
          action: 'CREATE',
          entityType: 'pricing_rule',
          entityId: row.id,
          summary: `Created fare rule ${dto.ruleName}`,
          after: dto,
        });
        return dto;
      })
      .catch(rethrowOneActiveConflict);

    return created;
  }

  async update(id: string, body: UpdateFareRuleBody, actorId?: string): Promise<FareRuleDto> {
    const existing = await this.databaseService.client.pricingRule.findUnique({
      where: { id },
      include: { vehicleType: true, serviceZone: true },
    });
    if (!existing) throw new FareRuleNotFoundError();

    // The rule's own type stays editable even once retired; moving a rule onto
    // another type must name that type exactly.
    const vehicleType =
      body.vehicleTypeId || body.vehicleType
        ? await this.vehicleTypeService.resolveForConfig(
            { id: body.vehicleTypeId, code: body.vehicleType },
            existing.vehicleTypeId,
          )
        : existing.vehicleType;
    const cityCode = body.cityCode ?? existing.cityCode;
    const serviceType =
      body.serviceType !== undefined ? parseServiceType(body.serviceType) : existing.serviceType;
    const serviceZoneId =
      body.serviceZoneId !== undefined ? body.serviceZoneId : existing.serviceZoneId;
    const isActive = body.status !== undefined ? body.status === 'active' : existing.isActive;

    if (serviceZoneId) {
      await this.adminServiceZoneService.assertZoneBelongsToCity(serviceZoneId, cityCode);
    }

    const key: RuleKey = {
      vehicleTypeId: vehicleType.id,
      cityCode,
      serviceType,
      serviceZoneId,
    };
    const before = this.toDto(existing);

    /// FR-034 (G2). This was three separate writes: retire the edited rule,
    /// retire anything else on the key, insert the new version. A failure after
    /// the first left the operator's rule deactivated and no replacement — the
    /// edit looked like a deletion, and the city fell back to GLOBAL pricing
    /// until someone noticed.
    return this.databaseService.transactionManager
      .execute(async (tx) => {
        await tx.pricingRule.update({ where: { id }, data: { isActive: false } });

        if (isActive) {
          await tx.pricingRule.updateMany({
            where: { ...exclusivityWhere(key), NOT: { id } },
            data: { isActive: false },
          });
        }

        const row = await tx.pricingRule.create({
          data: {
            vehicleTypeId: vehicleType.id,
            cityCode,
            serviceType,
            serviceZoneId,
            baseFare: body.baseFare ?? toNum(existing.baseFare),
            minimumFare: body.minimumFare ?? toNum(existing.minimumFare),
            perKmRate: body.perKmRate ?? toNum(existing.perKmRate),
            perMinuteRate: body.perMinuteRate ?? toNum(existing.perMinuteRate),
            freeWaitingMin: body.freeWaitingMinutes ?? existing.freeWaitingMin,
            waitingPerMin: body.waitingChargePerMinute ?? toNum(existing.waitingPerMin),
            bookingFee: body.bookingFee ?? toNum(existing.bookingFee),
            platformFeePct: body.platformFeePct ?? toNum(existing.platformFeePct),
            platformFeeFlat: body.platformFeeFlat ?? existing.platformFeeFlat,
            taxRatePct: body.taxRatePct ?? existing.taxRatePct,
            commissionRatePct: body.commissionRatePct ?? existing.commissionRatePct,
            version: existing.version + 1,
            isActive,
            effectiveFrom: body.effectiveFrom
              ? new Date(body.effectiveFrom)
              : existing.effectiveFrom,
            ...(body.effectiveTo
              ? { effectiveTo: new Date(body.effectiveTo) }
              : existing.effectiveTo
                ? { effectiveTo: existing.effectiveTo }
                : {}),
            ...(actorId ? { createdBy: actorId } : {}),
          },
          include: { vehicleType: true, serviceZone: true },
        });

        const after = this.toDto(row);
        await recordAdminAction(tx, {
          actorId,
          action: 'UPDATE',
          entityType: 'pricing_rule',
          entityId: row.id,
          summary: `Revised fare rule ${after.ruleName} to v${String(after.version)}`,
          before,
          after,
        });
        return after;
      })
      .catch(rethrowOneActiveConflict);
  }

  async activate(id: string, actorId?: string): Promise<FareRuleDto> {
    const existing = await this.databaseService.client.pricingRule.findUnique({
      where: { id },
      include: { vehicleType: true, serviceZone: true },
    });
    if (!existing) throw new FareRuleNotFoundError();

    const key: RuleKey = {
      vehicleTypeId: existing.vehicleTypeId,
      cityCode: existing.cityCode,
      serviceType: existing.serviceType,
      serviceZoneId: existing.serviceZoneId,
    };

    /// FR-034. Retiring the incumbent and promoting this rule is one change:
    /// between the two statements the key had no active rule at all.
    return this.databaseService.transactionManager
      .execute(async (tx) => {
        await tx.pricingRule.updateMany({
          where: exclusivityWhere(key),
          data: { isActive: false },
        });

        const updated = await tx.pricingRule.update({
          where: { id },
          data: { isActive: true },
          include: { vehicleType: true, serviceZone: true },
        });

        const after = this.toDto(updated);
        await recordAdminAction(tx, {
          actorId,
          action: 'UPDATE',
          entityType: 'pricing_rule',
          entityId: id,
          summary: `Activated fare rule ${after.ruleName}`,
          before: { status: 'inactive' },
          after: { status: after.status },
        });
        return after;
      })
      .catch(rethrowOneActiveConflict);
  }

  async deactivate(id: string, actorId?: string): Promise<FareRuleDto> {
    const existing = await this.databaseService.client.pricingRule.findUnique({ where: { id } });
    if (!existing) throw new FareRuleNotFoundError();

    return this.databaseService.transactionManager.execute(async (tx) => {
      const updated = await tx.pricingRule.update({
        where: { id },
        data: { isActive: false },
        include: { vehicleType: true, serviceZone: true },
      });

      const after = this.toDto(updated);
      await recordAdminAction(tx, {
        actorId,
        action: 'UPDATE',
        entityType: 'pricing_rule',
        entityId: id,
        summary: `Deactivated fare rule ${after.ruleName}`,
        before: { status: 'active' },
        after: { status: after.status },
      });
      return after;
    });
  }

  async remove(id: string, actorId?: string): Promise<void> {
    await this.deactivate(id, actorId);
  }

  private toDto(row: {
    id: string;
    cityCode: string;
    serviceType: RideServiceType | null;
    serviceZoneId: string | null;
    baseFare: { toString(): string };
    minimumFare: { toString(): string };
    perKmRate: { toString(): string };
    perMinuteRate: { toString(): string };
    freeWaitingMin: number;
    waitingPerMin: { toString(): string };
    bookingFee: { toString(): string };
    platformFeePct: { toString(): string };
    platformFeeFlat: { toString(): string } | null;
    taxRatePct: { toString(): string } | null;
    commissionRatePct: { toString(): string } | null;
    version: number;
    isActive: boolean;
    effectiveFrom: Date;
    effectiveTo: Date | null;
    createdAt: Date;
    vehicleTypeId: string;
    vehicleType: { code: string; name: string; hasAc: boolean; category: string };
    serviceZone?: { name: string } | null;
  }): FareRuleDto {
    const zoneLabel = row.serviceZone?.name ?? null;
    const svcLabel = serviceTypeUi(row.serviceType);
    const nameParts = [row.vehicleType.code, row.cityCode];
    if (svcLabel) nameParts.push(svcLabel);
    if (zoneLabel) nameParts.push(zoneLabel);

    return {
      id: row.id,
      ruleName: nameParts.join(' · '),
      version: row.version,
      vehicleType: row.vehicleType.code,
      vehicleTypeId: row.vehicleTypeId,
      vehicleTypeCode: row.vehicleType.code,
      vehicleTypeName: vehicleTypeDisplayName(row.vehicleType),
      vehicleCategory: row.vehicleType.category,
      cityCode: row.cityCode,
      serviceType: svcLabel,
      serviceZoneId: row.serviceZoneId,
      serviceZoneName: zoneLabel,
      baseFare: toNum(row.baseFare),
      minimumFare: toNum(row.minimumFare),
      perKmRate: toNum(row.perKmRate),
      perMinuteRate: toNum(row.perMinuteRate),
      freeWaitingMinutes: row.freeWaitingMin,
      waitingChargePerMinute: toNum(row.waitingPerMin),
      bookingFee: toNum(row.bookingFee),
      platformFeePct: toNum(row.platformFeePct),
      platformFeeFlat: row.platformFeeFlat != null ? toNum(row.platformFeeFlat) : null,
      taxRatePct: row.taxRatePct != null ? toNum(row.taxRatePct) : null,
      commissionRatePct: row.commissionRatePct != null ? toNum(row.commissionRatePct) : null,
      status: row.isActive ? 'active' : 'inactive',
      effectiveFrom: row.effectiveFrom.toISOString().slice(0, 10),
      ...(row.effectiveTo ? { effectiveTo: row.effectiveTo.toISOString().slice(0, 10) } : {}),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.createdAt.toISOString(),
    };
  }
}
