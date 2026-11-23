import { randomUUID } from 'node:crypto';
import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import { Prisma, type RideServiceType } from '../../../../generated/prisma/index.js';
import { recordAdminAction } from '../../audit/index.js';
import {
  FareRuleConflictError,
  FareRuleNotFoundError,
  FareRuleStaleError,
  PricingAdminError,
} from '../pricing.errors.js';
import type {
  CreateFareRuleBody,
  ListFareRulesQuery,
  PreviewFareRuleBody,
  UpdateFareRuleBody,
} from './fare.schemas.js';
import { PricingService } from '@modules/pricing';
import {
  buildScopeLookupCandidates,
  pickWinningScope,
} from '@modules/pricing/utils/scope-precedence.js';
import {
  AdminServiceZoneService,
  parseServiceType,
  serviceTypeUi,
} from '../service-zone/service-zone.service.js';
import {
  VehicleTypeService,
  vehicleTypeDisplayName,
} from '@modules/vehicles/services/vehicle-type.service.js';

export interface FareRuleWarning {
  code: 'FARE_RULE_GAP';
  message: string;
}

export interface FareRuleDto {
  id: string;
  ruleName: string;
  version: number;
  ruleFamilyId: string;
  supersedesId: string | null;
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
  effectiveFromIso: string;
  effectiveTo?: string;
  effectiveToIso?: string | null;
  warnings?: FareRuleWarning[];
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
  /// minimum fare, surge, discount, ceiling, live DB tax/commission configs, platform fee, driver
  /// earning). Read-only.
  async preview(body: PreviewFareRuleBody) {
    const now = new Date();
    let resolvedTaxRatePct: number | null = body.taxRatePct ?? null;
    let resolvedCommissionRatePct: number | null = body.commissionRatePct ?? null;

    if (resolvedTaxRatePct === null || resolvedCommissionRatePct === null) {
      let vehicleTypeId: string | null = null;
      if (body.vehicleType) {
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          body.vehicleType,
        );
        const vt = await this.databaseService.client.vehicleType.findFirst({
          where: isUuid ? { id: body.vehicleType } : { code: body.vehicleType },
          select: { id: true },
        });
        vehicleTypeId = vt?.id ?? null;
      }

      const normalizedCityCode =
        body.cityCode && body.cityCode.trim().toUpperCase() !== 'GLOBAL'
          ? body.cityCode.trim().toUpperCase()
          : null;

      const scopeCandidates = buildScopeLookupCandidates({
        cityCode: normalizedCityCode,
        serviceZoneId: body.serviceZoneId ?? null,
        vehicleTypeId,
      });

      if (resolvedTaxRatePct === null) {
        const taxScopes = await this.databaseService.client.taxConfigurationScope.findMany({
          where: {
            taxKind: 'PASSENGER_RIDE_GST',
            isEnforced: true,
            effectiveFrom: { lte: now },
            OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
            AND: [{ OR: scopeCandidates }],
          },
          include: { config: true },
        });
        const winningTax = pickWinningScope(taxScopes);
        if (winningTax) {
          resolvedTaxRatePct = winningTax.config.isEnabled
            ? Number(winningTax.config.ratePct.toString())
            : 0;
        } else {
          const recScopes =
            await this.databaseService.client.gstRecoveryConfigurationScope.findMany({
              where: {
                isEnforced: true,
                effectiveFrom: { lte: now },
                OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
                AND: [{ OR: scopeCandidates }],
              },
              include: { config: true },
            });
          const winningRec = pickWinningScope(recScopes);
          resolvedTaxRatePct = winningRec
            ? winningRec.config.isEnabled
              ? Number(winningRec.config.recoveryRatePct.toString())
              : 0
            : 0;
        }
      }

      if (resolvedCommissionRatePct === null) {
        const commScopes = await this.databaseService.client.commissionConfigurationScope.findMany({
          where: {
            isEnforced: true,
            effectiveFrom: { lte: now },
            OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
            AND: [{ OR: scopeCandidates }],
          },
          include: { config: true },
        });
        const winningComm = pickWinningScope(commScopes);
        if (winningComm) {
          resolvedCommissionRatePct = winningComm.config.isEnabled
            ? Number(winningComm.config.commissionRatePct.toString())
            : 0;
        }
      }
    }

    const card = this.pricingService.rateCardFor({
      baseFare: body.baseFare,
      perKmRate: body.perKmRate,
      perMinuteRate: body.perMinuteRate,
      waitingPerMin: body.waitingChargePerMinute,
      freeWaitingMin: body.freeWaitingMinutes,
      bookingFee: body.bookingFee,
      platformFeePct: body.platformFeePct,
      platformFeeFlat: body.platformFeeFlat ?? 0,
      taxRatePct: resolvedTaxRatePct,
      commissionRatePct: resolvedCommissionRatePct,
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
        taxRateIsDefault: body.taxRatePct == null,
        commissionRatePct: card.commissionRatePct,
        commissionRateIsDefault: body.commissionRatePct == null,
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
        orderBy: [{ isActive: 'desc' }, { updatedAt: 'desc' }, { createdAt: 'desc' }],
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

  /// Phase 1.1: Time-aware exclusivity for active fare rules on a RuleKey.
  /// - An overlapping incumbent starting STRICTLY earlier than `effectiveFrom` is
  ///   closed at `effectiveTo = effectiveFrom` (staying active until handoff).
  /// - An overlapping incumbent starting at or after `effectiveFrom` is retired
  ///   (`isActive = false`).
  /// - Detects any scheduling gap between a prior rule's `effectiveTo` and `effectiveFrom`.
  private async applyTimeAwareExclusivity(
    tx: TransactionClient,
    key: RuleKey,
    effectiveFrom: Date,
    effectiveTo: Date | null,
    excludeId?: string,
  ): Promise<FareRuleWarning[]> {
    const activeSiblings = await tx.pricingRule.findMany({
      where: {
        ...exclusivityWhere(key),
        ...(excludeId ? { NOT: { id: excludeId } } : {}),
      },
      orderBy: { effectiveFrom: 'asc' },
    });

    const newFromMs = effectiveFrom.getTime();
    const newToMs = effectiveTo ? effectiveTo.getTime() : Number.POSITIVE_INFINITY;
    let coveredBefore = false;
    let latestPriorEnd: Date | null = null;

    for (const inc of activeSiblings) {
      const incFromMs = inc.effectiveFrom.getTime();
      const incToMs = inc.effectiveTo ? inc.effectiveTo.getTime() : Number.POSITIVE_INFINITY;
      const overlaps = incToMs > newFromMs && incFromMs < newToMs;

      if (overlaps) {
        if (incFromMs < newFromMs) {
          // Close incumbent cleanly at the successor's start time without turning it off early.
          await tx.pricingRule.update({
            where: { id: inc.id },
            data: { effectiveTo: effectiveFrom },
          });
          coveredBefore = true;
        } else {
          // Incumbent starts at or after successor start -> replace/retire it.
          await tx.pricingRule.update({
            where: { id: inc.id },
            data: { isActive: false },
          });
        }
      } else if (inc.effectiveTo) {
        if (inc.effectiveTo.getTime() === newFromMs) {
          coveredBefore = true;
        } else if (inc.effectiveTo.getTime() < newFromMs) {
          if (!latestPriorEnd || inc.effectiveTo.getTime() > latestPriorEnd.getTime()) {
            latestPriorEnd = inc.effectiveTo;
          }
        }
      }
    }

    const warnings: FareRuleWarning[] = [];
    if (!coveredBefore && latestPriorEnd) {
      warnings.push({
        code: 'FARE_RULE_GAP',
        message: `There is an uncovered pricing gap between ${latestPriorEnd.toISOString()} and ${effectiveFrom.toISOString()}.`,
      });
    }
    return warnings;
  }

  async listVersions(id: string): Promise<FareRuleDto[]> {
    const row = await this.databaseService.client.pricingRule.findUnique({
      where: { id },
      select: { id: true, ruleFamilyId: true },
    });
    if (!row) throw new FareRuleNotFoundError();
    const familyId = row.ruleFamilyId ?? row.id;
    const versions = await this.databaseService.client.pricingRule.findMany({
      where: {
        OR: [{ ruleFamilyId: familyId }, { id: familyId }],
      },
      include: { vehicleType: true, serviceZone: true },
      orderBy: [{ version: 'desc' }, { createdAt: 'desc' }],
    });
    return versions.map((v) => this.toDto(v));
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
    const effectiveFrom = new Date(body.effectiveFrom);
    const effectiveTo = body.effectiveTo ? new Date(body.effectiveTo) : null;

    if (effectiveTo && effectiveTo.getTime() <= effectiveFrom.getTime()) {
      throw new PricingAdminError(
        'effectiveTo must be strictly after effectiveFrom',
        'VALIDATION',
        400,
      );
    }

    if (serviceZoneId) {
      await this.adminServiceZoneService.assertZoneBelongsToCity(serviceZoneId, cityCode);
    }

    const key: RuleKey = {
      vehicleTypeId: vehicleType.id,
      cityCode,
      serviceType,
      serviceZoneId,
    };

    const created = await this.databaseService.transactionManager
      .execute(async (tx) => {
        // Strict duplicate active guard (Option A): block creating a second active overlapping rule
        // for the exact same (Vehicle + City + Service Type + Service Zone). Operators should edit
        // the existing rule to create v2, or schedule a non-overlapping future effective window.
        if (isActive) {
          const activeSiblings = await tx.pricingRule.findMany({
            where: exclusivityWhere(key),
            include: { vehicleType: true, serviceZone: true },
            orderBy: { version: 'desc' },
          });
          const newFromMs = effectiveFrom.getTime();
          const newToMs = effectiveTo ? effectiveTo.getTime() : Number.POSITIVE_INFINITY;
          const overlappingActive = activeSiblings.find((inc) => {
            const incFromMs = inc.effectiveFrom.getTime();
            const incToMs = inc.effectiveTo ? inc.effectiveTo.getTime() : Number.POSITIVE_INFINITY;
            return incToMs > newFromMs && incFromMs < newToMs;
          });
          if (overlappingActive) {
            const zonePart = overlappingActive.serviceZone?.name
              ? ` · ${overlappingActive.serviceZone.name}`
              : '';
            throw new FareRuleConflictError(
              `An active fare rule (v${overlappingActive.version}) already exists for ${overlappingActive.vehicleType.code} · ${cityCode}${zonePart}. Edit that rule to create v${overlappingActive.version + 1}, or schedule a non-overlapping Effective From date.`,
            );
          }
        }

        // Link to existing rule family and increment version cleanly if this key already has history
        // (e.g. previous rule was deactivated or ends before this scheduled window) — never two v1s.
        const latestSameKey = await tx.pricingRule.findFirst({
          where: {
            vehicleTypeId: key.vehicleTypeId,
            cityCode: key.cityCode,
            serviceType: key.serviceType,
            serviceZoneId: key.serviceZoneId,
          },
          orderBy: [{ version: 'desc' }, { createdAt: 'desc' }],
          select: { id: true, ruleFamilyId: true, version: true },
        });

        const warnings = isActive
          ? await this.applyTimeAwareExclusivity(tx, key, effectiveFrom, effectiveTo)
          : [];

        const newId = randomUUID();
        const ruleFamilyId = latestSameKey
          ? (latestSameKey.ruleFamilyId ?? latestSameKey.id)
          : newId;
        const supersedesId = latestSameKey ? latestSameKey.id : null;
        const nextVersion = latestSameKey ? latestSameKey.version + 1 : 1;

        const row = await tx.pricingRule.create({
          data: {
            id: newId,
            ruleFamilyId,
            supersedesId,
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
            version: nextVersion,
            isActive,
            effectiveFrom,
            effectiveTo,
            ...(actorId ? { createdBy: actorId } : {}),
          },
          include: { vehicleType: true, serviceZone: true },
        });

        const dto = this.toDto(row, warnings);
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

    if (body.expectedVersion !== undefined && body.expectedVersion !== existing.version) {
      throw new FareRuleStaleError(body.expectedVersion, existing.version);
    }

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
    const effectiveFrom = body.effectiveFrom
      ? new Date(body.effectiveFrom)
      : existing.effectiveFrom;
    const effectiveTo =
      body.effectiveTo !== undefined
        ? body.effectiveTo
          ? new Date(body.effectiveTo)
          : null
        : existing.effectiveTo;

    if (effectiveTo && effectiveTo.getTime() <= effectiveFrom.getTime()) {
      throw new PricingAdminError(
        'effectiveTo must be strictly after effectiveFrom',
        'VALIDATION',
        400,
      );
    }

    if (serviceZoneId) {
      await this.adminServiceZoneService.assertZoneBelongsToCity(serviceZoneId, cityCode);
    }

    const key: RuleKey = {
      vehicleTypeId: vehicleType.id,
      cityCode,
      serviceType,
      serviceZoneId,
    };
    const sameKey =
      existing.vehicleTypeId === key.vehicleTypeId &&
      existing.cityCode === key.cityCode &&
      existing.serviceType === key.serviceType &&
      existing.serviceZoneId === key.serviceZoneId;
    const familyId = existing.ruleFamilyId ?? existing.id;
    const before = this.toDto(existing);

    return this.databaseService.transactionManager
      .execute(async (tx) => {
        // Lock the target row to serialize concurrent edits on the same version.
        const lockedRows = await tx.$queryRaw<
          Array<{ id: string; version: number; is_active: boolean }>
        >`
          SELECT "id", "version", "is_active"
          FROM "pricing_rules"
          WHERE "id" = ${id}::uuid
          FOR UPDATE
        `;
        const locked = lockedRows[0];
        if (!locked) throw new FareRuleNotFoundError();
        if (body.expectedVersion !== undefined) {
          // Also ensure no successor version was already created from this rule.
          const latestInFamily = await tx.pricingRule.findFirst({
            where: { OR: [{ ruleFamilyId: familyId }, { id: familyId }] },
            orderBy: { version: 'desc' },
            select: { version: true },
          });
          const actualVersion = latestInFamily?.version ?? locked.version;
          if (body.expectedVersion !== actualVersion) {
            throw new FareRuleStaleError(body.expectedVersion, actualVersion);
          }
        }

        // If scheduling a future replacement of an active rule on the same key,
        // keep the existing rule live up to the new rule's effectiveFrom!
        const keepExistingUntilHandoff =
          isActive &&
          sameKey &&
          locked.is_active &&
          effectiveFrom.getTime() > existing.effectiveFrom.getTime() &&
          effectiveFrom.getTime() > Date.now();

        if (keepExistingUntilHandoff) {
          await tx.pricingRule.update({
            where: { id },
            data: { effectiveTo: effectiveFrom },
          });
        } else {
          await tx.pricingRule.update({ where: { id }, data: { isActive: false } });
        }

        const warnings = isActive
          ? await this.applyTimeAwareExclusivity(tx, key, effectiveFrom, effectiveTo, id)
          : [];

        const row = await tx.pricingRule.create({
          data: {
            ruleFamilyId: familyId,
            supersedesId: existing.id,
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
            platformFeeFlat:
              body.platformFeeFlat !== undefined ? body.platformFeeFlat : existing.platformFeeFlat,
            taxRatePct: body.taxRatePct !== undefined ? body.taxRatePct : existing.taxRatePct,
            commissionRatePct:
              body.commissionRatePct !== undefined
                ? body.commissionRatePct
                : existing.commissionRatePct,
            version: existing.version + 1,
            isActive,
            effectiveFrom,
            effectiveTo,
            ...(actorId ? { createdBy: actorId } : {}),
          },
          include: { vehicleType: true, serviceZone: true },
        });

        const after = this.toDto(row, warnings);
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

    return this.databaseService.transactionManager
      .execute(async (tx) => {
        const now = new Date();
        // If reactivating an older rule whose effective window was closed in the past,
        // reopen it starting now so live quotes immediately evaluate it.
        const wasClosedInPast =
          existing.effectiveTo !== null && existing.effectiveTo.getTime() <= now.getTime();
        const nextEffectiveFrom = wasClosedInPast ? now : existing.effectiveFrom;
        const nextEffectiveTo = wasClosedInPast ? null : existing.effectiveTo;

        const warnings = await this.applyTimeAwareExclusivity(
          tx,
          key,
          nextEffectiveFrom,
          nextEffectiveTo,
          id,
        );

        const updated = await tx.pricingRule.update({
          where: { id },
          data: {
            isActive: true,
            effectiveFrom: nextEffectiveFrom,
            effectiveTo: nextEffectiveTo,
          },
          include: { vehicleType: true, serviceZone: true },
        });

        const after = this.toDto(updated, warnings);
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
    const existing = await this.databaseService.client.pricingRule.findUnique({
      where: { id },
      include: { vehicleType: true, serviceZone: true },
    });
    if (!existing) throw new FareRuleNotFoundError();

    if (existing.isActive) {
      throw new PricingAdminError(
        'Deactivate this fare rule before deleting it.',
        'RULE_IS_ACTIVE',
        409,
      );
    }

    const [rideReqCount, quoteOptCount] = await Promise.all([
      this.databaseService.client.rideRequest.count({ where: { pricingRuleId: id } }),
      this.databaseService.client.rideQuoteOption.count({ where: { pricingRuleId: id } }),
    ]);

    if (rideReqCount > 0 || quoteOptCount > 0) {
      throw new PricingAdminError(
        'This fare rule is referenced by past ride quotes or requests and cannot be permanently deleted. Keep it Inactive for billing audit.',
        'RULE_REFERENCED_BY_RIDES',
        409,
      );
    }

    const before = this.toDto(existing);
    await this.databaseService.transactionManager.execute(async (tx) => {
      await tx.pricingRule.updateMany({
        where: { supersedesId: id },
        data: { supersedesId: existing.supersedesId ?? null },
      });
      await tx.pricingRule.delete({ where: { id } });
      await recordAdminAction(tx, {
        actorId,
        action: 'DELETE',
        entityType: 'pricing_rule',
        entityId: id,
        summary: `Deleted inactive fare rule ${before.ruleName} (v${before.version})`,
        before,
      });
    });
  }

  private toDto(
    row: {
      id: string;
      ruleFamilyId?: string | null;
      supersedesId?: string | null;
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
      updatedAt?: Date;
      vehicleTypeId: string;
      vehicleType: { code: string; name: string; hasAc: boolean; category: string };
      serviceZone?: { name: string } | null;
    },
    warnings?: FareRuleWarning[],
  ): FareRuleDto {
    const zoneLabel = row.serviceZone?.name ?? null;
    const svcLabel = serviceTypeUi(row.serviceType);
    const nameParts = [row.vehicleType.code, row.cityCode];
    if (svcLabel) nameParts.push(svcLabel);
    if (zoneLabel) nameParts.push(zoneLabel);

    return {
      id: row.id,
      ruleName: nameParts.join(' · '),
      version: row.version,
      ruleFamilyId: row.ruleFamilyId ?? row.id,
      supersedesId: row.supersedesId ?? null,
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
      effectiveFromIso: row.effectiveFrom.toISOString(),
      ...(row.effectiveTo
        ? {
            effectiveTo: row.effectiveTo.toISOString().slice(0, 10),
            effectiveToIso: row.effectiveTo.toISOString(),
          }
        : { effectiveToIso: null }),
      ...(warnings && warnings.length > 0 ? { warnings } : {}),
      createdAt: row.createdAt.toISOString(),
      updatedAt: (row.updatedAt ?? row.createdAt).toISOString(),
    };
  }
}
