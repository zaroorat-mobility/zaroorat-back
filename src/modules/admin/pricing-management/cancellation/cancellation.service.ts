import { randomUUID } from 'node:crypto';
import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import { lockForAudit, recordAdminAction, type AuditActor } from '../../audit/index.js';
import { VehicleTypeService } from '@modules/vehicles/services/vehicle-type.service.js';
import {
  CancellationPolicyService,
  type CancellationEvaluationResult,
  type CancellationScenarioDb,
} from '@modules/pricing';
import {
  CancellationPolicyConflictError,
  CancellationPolicyNotFoundError,
  CancellationPolicyStaleError,
} from '../pricing.errors.js';
import type {
  CreateCancellationPolicyBody,
  EvaluateCancellationPolicyBody,
  ListCancellationPoliciesQuery,
  UpdateCancellationPolicyBody,
} from './cancellation.schemas.js';

const ACTOR_MAP: Record<string, 'RIDER' | 'DRIVER'> = {
  rider: 'RIDER',
  driver: 'DRIVER',
  RIDER: 'RIDER',
  DRIVER: 'DRIVER',
};

const SCENARIO_MAP: Record<string, CancellationScenarioDb> = {
  before_assignment: 'BEFORE_ASSIGNMENT',
  after_assignment: 'AFTER_ASSIGNMENT',
  after_arrival: 'AFTER_ARRIVAL',
  no_show: 'NO_SHOW',
  BEFORE_ASSIGNMENT: 'BEFORE_ASSIGNMENT',
  AFTER_ASSIGNMENT: 'AFTER_ASSIGNMENT',
  AFTER_ARRIVAL: 'AFTER_ARRIVAL',
  NO_SHOW: 'NO_SHOW',
};

const FEE_MAP: Record<string, 'FLAT' | 'PERCENT'> = {
  fixed: 'FLAT',
  percentage: 'PERCENT',
  FLAT: 'FLAT',
  PERCENT: 'PERCENT',
};

export interface CancellationPolicyDto {
  id: string;
  familyId: string;
  version: number;
  supersedesId: string | null;
  ruleName: string;
  actor: 'rider' | 'driver';
  scenario: 'before_assignment' | 'after_assignment' | 'after_arrival' | 'no_show';
  chargeType: 'fixed' | 'percentage';
  chargeAmount: number;
  feeBase: 'QUOTED_FARE' | 'BASE_FARE' | 'MINIMUM_FARE';
  maxFee: number | null;
  freeCancelWindowSec: number;
  driverCompensationType: 'NONE' | 'FLAT' | 'PERCENT_OF_FEE';
  driverCompensationAmount: number;
  driverPenaltyAmount: number | null;
  status: 'active' | 'inactive';
  effectiveFrom: string;
  effectiveTo: string | null;
  cityCode?: string;
  /// The exact vehicle type this policy is scoped to; absent means every type.
  vehicleTypeId?: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

function toNum(value: { toString(): string } | number): number {
  return typeof value === 'number' ? value : Number(value.toString());
}

function actorUi(value: string): 'rider' | 'driver' {
  return value.toUpperCase() === 'DRIVER' ? 'driver' : 'rider';
}

function scenarioUi(
  value: string | null,
): 'before_assignment' | 'after_assignment' | 'after_arrival' | 'no_show' {
  const key = (value ?? 'AFTER_ASSIGNMENT').toUpperCase();
  if (key === 'BEFORE_ASSIGNMENT') return 'before_assignment';
  if (key === 'AFTER_ARRIVAL') return 'after_arrival';
  if (key === 'NO_SHOW') return 'no_show';
  return 'after_assignment';
}

function feeUi(value: string): 'fixed' | 'percentage' {
  return value.toUpperCase() === 'PERCENT' ? 'percentage' : 'fixed';
}

function isPgExclusionViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; cause?: { code?: string }; meta?: { code?: string } };
  return (
    e.code === '23P01' ||
    e.cause?.code === '23P01' ||
    e.meta?.code === '23P01' ||
    (err instanceof Error && err.message.includes('cancellation_policies_no_overlap_active'))
  );
}

function windowsOverlap(aFrom: Date, aTo: Date | null, bFrom: Date, bTo: Date | null): boolean {
  const aEndsAfterBStarts = aTo === null || aTo.getTime() > bFrom.getTime();
  const bEndsAfterAStarts = bTo === null || bTo.getTime() > aFrom.getTime();
  return aEndsAfterBStarts && bEndsAfterAStarts;
}

export class AdminCancellationService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly vehicleTypeService: VehicleTypeService,
    private readonly cancellationPolicyService: CancellationPolicyService,
  ) {}

  async list(query: ListCancellationPoliciesQuery): Promise<{
    data: CancellationPolicyDto[];
    meta: { currentPage: number; totalPages: number; pageSize: number; totalCount: number };
  }> {
    const where: Record<string, unknown> = {};
    if (query.status === 'active') where.isActive = true;
    else if (query.status === 'inactive') where.isActive = false;
    if (query.actor) where.cancelledBy = ACTOR_MAP[query.actor];
    if (query.scenario) where.minStatus = SCENARIO_MAP[query.scenario];
    if (query.cityCode) where.cityCode = query.cityCode;
    if (query.vehicleTypeId) where.vehicleTypeId = query.vehicleTypeId;

    const search = query.search?.trim();
    if (search) {
      const normalized = search.toUpperCase().replace(/\s+/g, '_');
      where.OR = [
        { ruleName: { contains: search, mode: 'insensitive' } },
        { cancelledBy: { contains: normalized, mode: 'insensitive' } },
        { minStatus: { contains: normalized, mode: 'insensitive' } },
        { cityCode: { contains: search, mode: 'insensitive' } },
      ];
    }

    const skip = (query.page - 1) * query.limit;
    const [totalCount, rows] = await Promise.all([
      this.databaseService.client.cancellationPolicy.count({ where }),
      this.databaseService.client.cancellationPolicy.findMany({
        where,
        orderBy: [{ isActive: 'desc' }, { updatedAt: 'desc' }, { createdAt: 'desc' }],
        skip,
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

  async getById(id: string): Promise<CancellationPolicyDto> {
    const row = await this.databaseService.client.cancellationPolicy.findUnique({
      where: { id },
    });
    if (!row) throw new CancellationPolicyNotFoundError();
    return this.toDto(row);
  }

  async listVersions(id: string): Promise<CancellationPolicyDto[]> {
    const existing = await this.databaseService.client.cancellationPolicy.findUnique({
      where: { id },
    });
    if (!existing) throw new CancellationPolicyNotFoundError();

    const rows = await this.databaseService.client.cancellationPolicy.findMany({
      where: { familyId: existing.familyId },
      orderBy: [{ version: 'desc' }, { createdAt: 'desc' }],
    });
    return rows.map((row) => this.toDto(row));
  }

  async evaluate(
    body: EvaluateCancellationPolicyBody,
  ): Promise<CancellationEvaluationResult & { enforcementEnabled: boolean }> {
    const scenario = SCENARIO_MAP[body.scenario] ?? 'AFTER_ASSIGNMENT';
    const vehicleTypeId =
      body.vehicleTypeId || body.vehicleType
        ? (
            await this.vehicleTypeService.resolveForConfig({
              id: body.vehicleTypeId,
              code: body.vehicleType,
            })
          ).id
        : null;

    const actorInput =
      body.actor.toUpperCase() === 'SYSTEM'
        ? 'SYSTEM'
        : body.actor.toUpperCase() === 'DRIVER'
          ? 'DRIVER'
          : 'RIDER';

    const [enforcementEnabled, result] = await Promise.all([
      this.cancellationPolicyService.isEnforcementEnabled(),
      this.cancellationPolicyService.resolve({
        actor: actorInput,
        scenario,
        cityCode: body.cityCode ?? null,
        vehicleTypeId,
        elapsedSec: body.elapsedSec,
        quotedFare: body.quotedFare,
        baseFare: body.baseFare ?? null,
        minimumFare: body.minimumFare ?? null,
        at: body.at ? new Date(body.at) : new Date(),
      }),
    ]);

    return {
      ...result,
      enforcementEnabled,
    };
  }

  async create(
    body: CreateCancellationPolicyBody,
    actor: AuditActor,
  ): Promise<CancellationPolicyDto> {
    const cancelledBy = ACTOR_MAP[body.actor] ?? 'RIDER';
    const minStatus = SCENARIO_MAP[body.scenario] ?? 'AFTER_ASSIGNMENT';
    const feeType = FEE_MAP[body.chargeType] ?? 'FLAT';
    const isActive = body.status !== 'inactive';
    const vehicleTypeId =
      body.vehicleTypeId || body.vehicleType
        ? (
            await this.vehicleTypeService.resolveForConfig({
              id: body.vehicleTypeId,
              code: body.vehicleType,
            })
          ).id
        : null;
    const cityCode = body.cityCode ?? null;
    const effectiveFrom = body.effectiveFrom ? new Date(body.effectiveFrom) : new Date();
    const effectiveTo = body.effectiveTo ? new Date(body.effectiveTo) : null;
    const ruleName =
      body.ruleName?.trim() ||
      `${actorUi(cancelledBy)} · ${scenarioUi(minStatus).replace(/_/g, ' ')}`;

    try {
      return await this.databaseService.transactionManager.execute(async (tx) => {
        // Strict duplicate active guard: never silently clobber an active policy on Create.
        if (isActive) {
          const activePeers = await tx.cancellationPolicy.findMany({
            where: {
              cancelledBy,
              minStatus,
              cityCode,
              vehicleTypeId,
              isActive: true,
            },
            orderBy: [{ version: 'desc' }, { createdAt: 'desc' }],
          });
          const overlappingActive = activePeers.find((peer) =>
            windowsOverlap(peer.effectiveFrom, peer.effectiveTo, effectiveFrom, effectiveTo),
          );
          if (overlappingActive) {
            const label =
              overlappingActive.ruleName ||
              `${actorUi(cancelledBy)} · ${scenarioUi(minStatus).replace(/_/g, ' ')}`;
            throw new CancellationPolicyConflictError(
              `An active cancellation policy "${label}" (v${overlappingActive.version}) already exists for this scope. Edit that policy to create v${overlappingActive.version + 1}, or deactivate it first.`,
            );
          }
        }

        // Preserve monotonic version lineage when prior inactive/retired versions exist on the same scope.
        const latestSameScope = await tx.cancellationPolicy.findFirst({
          where: {
            cancelledBy,
            minStatus,
            cityCode,
            vehicleTypeId,
          },
          orderBy: [{ version: 'desc' }, { createdAt: 'desc' }],
        });

        const familyId = latestSameScope ? latestSameScope.familyId : randomUUID();
        const version = latestSameScope ? latestSameScope.version + 1 : 1;
        const supersedesId = latestSameScope ? latestSameScope.id : null;

        const created = await tx.cancellationPolicy.create({
          data: {
            ruleName,
            familyId,
            version,
            supersedesId,
            cancelledBy,
            minStatus,
            feeType,
            feeAmount: body.chargeAmount,
            feeBase: body.feeBase ?? 'QUOTED_FARE',
            maxFee: body.maxFee ?? null,
            freeCancelWindowSec: body.freeCancelWindowSec ?? 120,
            driverCompensationType: body.driverCompensationType ?? 'NONE',
            driverCompensationAmount: body.driverCompensationAmount ?? 0,
            driverPenaltyAmount: body.driverPenaltyAmount ?? null,
            cityCode,
            vehicleTypeId,
            effectiveFrom,
            effectiveTo,
            isActive,
            createdBy: actor.actorId,
          },
        });
        await recordAdminAction(tx, {
          ...actor,
          action: 'CREATE',
          entityType: 'cancellation_policy',
          entityId: created.id,
          summary: `Cancellation policy v${version} created (${ruleName})`,
          after: created,
          result: 'SUCCESS',
        });
        return this.toDto(created);
      });
    } catch (err) {
      if (isPgExclusionViolation(err)) {
        throw new CancellationPolicyConflictError(
          'An active cancellation policy already covers this scope and effective window.',
        );
      }
      throw err;
    }
  }

  /// Phase 3: Versioned end-and-replace editing.
  /// Pure `{ status }` toggles update in-place; any substantive edit retires/closes
  /// the incumbent and creates a new version (`version = max + 1`, `supersedesId = id`)
  /// in the same `familyId` so historical ride_cancellations keep immutable lineage.
  async update(
    id: string,
    body: UpdateCancellationPolicyBody,
    actor: AuditActor,
  ): Promise<CancellationPolicyDto> {
    try {
      return await this.databaseService.transactionManager.execute(async (tx) => {
        const existing = await this.lockExisting(tx, id);
        if (body.expectedVersion !== undefined && existing.version !== body.expectedVersion) {
          throw new CancellationPolicyStaleError(body.expectedVersion, existing.version);
        }

        const substantiveKeys = (
          Object.keys(body) as Array<keyof UpdateCancellationPolicyBody>
        ).filter((key) => key !== 'status' && key !== 'expectedVersion' && body[key] !== undefined);

        // Pure active/inactive status toggle stays in-place cleanly.
        if (substantiveKeys.length === 0 && body.status !== undefined) {
          const nextActive = body.status === 'active';
          const isExpired =
            nextActive &&
            existing.effectiveTo !== null &&
            existing.effectiveTo.getTime() <= Date.now();
          const nextEffectiveFrom = isExpired ? new Date() : existing.effectiveFrom;
          const nextEffectiveTo = isExpired ? null : existing.effectiveTo;

          if (nextActive && !existing.isActive) {
            await this.applyTimeAwareExclusivity(
              tx,
              {
                cancelledBy: existing.cancelledBy,
                minStatus: existing.minStatus,
                cityCode: existing.cityCode,
                vehicleTypeId: existing.vehicleTypeId,
              },
              nextEffectiveFrom,
              nextEffectiveTo,
              actor,
              existing.id,
            );
          }
          const toggled = await tx.cancellationPolicy.update({
            where: { id },
            data: {
              isActive: nextActive,
              ...(isExpired
                ? { effectiveFrom: nextEffectiveFrom, effectiveTo: nextEffectiveTo }
                : {}),
            },
          });
          await this.audit(
            tx,
            actor,
            existing,
            toggled,
            nextActive ? 'Cancellation policy activated' : 'Cancellation policy deactivated',
          );
          return this.toDto(toggled);
        }

        const cancelledBy = body.actor
          ? (ACTOR_MAP[body.actor] ?? existing.cancelledBy)
          : existing.cancelledBy;
        const minStatus = body.scenario
          ? (SCENARIO_MAP[body.scenario] ?? existing.minStatus)
          : existing.minStatus;
        const feeType = body.chargeType
          ? (FEE_MAP[body.chargeType] ?? existing.feeType)
          : existing.feeType;
        const feeAmount =
          body.chargeAmount !== undefined ? body.chargeAmount : toNum(existing.feeAmount);
        if (feeType === 'PERCENT' && feeAmount > 100) {
          throw new CancellationPolicyConflictError(
            'Percentage chargeAmount must be between 0 and 100',
          );
        }

        const driverCompensationType =
          body.driverCompensationType ?? existing.driverCompensationType;
        const driverCompensationAmount =
          body.driverCompensationAmount !== undefined
            ? body.driverCompensationAmount
            : toNum(existing.driverCompensationAmount);
        if (driverCompensationType === 'PERCENT_OF_FEE' && driverCompensationAmount > 100) {
          throw new CancellationPolicyConflictError(
            'PERCENT_OF_FEE driverCompensationAmount must be between 0 and 100',
          );
        }

        const isActive = body.status !== undefined ? body.status === 'active' : existing.isActive;
        const nextVehicleTypeId =
          body.vehicleTypeId === null
            ? null
            : body.vehicleTypeId || body.vehicleType
              ? (
                  await this.vehicleTypeService.resolveForConfig(
                    { id: body.vehicleTypeId, code: body.vehicleType },
                    existing.vehicleTypeId,
                  )
                ).id
              : existing.vehicleTypeId;
        const cityCode = body.cityCode !== undefined ? body.cityCode : existing.cityCode;
        const effectiveFrom = body.effectiveFrom ? new Date(body.effectiveFrom) : new Date();
        const effectiveTo =
          body.effectiveTo !== undefined
            ? body.effectiveTo
              ? new Date(body.effectiveTo)
              : null
            : existing.effectiveTo;
        if (effectiveTo && effectiveTo <= effectiveFrom) {
          throw new CancellationPolicyConflictError(
            'effectiveTo must be strictly after effectiveFrom',
          );
        }

        const ruleName =
          body.ruleName?.trim() ||
          existing.ruleName ||
          `${actorUi(cancelledBy)} · ${scenarioUi(minStatus).replace(/_/g, ' ')}`;

        // Retire or close the incumbent version atomically before inserting the successor
        // so the GiST exclusion constraint allows the handoff without conflict.
        if (existing.isActive) {
          const sameScope =
            existing.cancelledBy === cancelledBy &&
            existing.minStatus === minStatus &&
            existing.cityCode === cityCode &&
            existing.vehicleTypeId === nextVehicleTypeId;
          const isFutureScheduledHandoff =
            isActive &&
            sameScope &&
            effectiveFrom.getTime() > existing.effectiveFrom.getTime() &&
            effectiveFrom.getTime() > Date.now();

          if (isFutureScheduledHandoff) {
            await tx.cancellationPolicy.update({
              where: { id: existing.id },
              data: { effectiveTo: effectiveFrom },
            });
          } else {
            await tx.cancellationPolicy.update({
              where: { id: existing.id },
              data: { isActive: false },
            });
          }
        }

        if (isActive) {
          await this.applyTimeAwareExclusivity(
            tx,
            { cancelledBy, minStatus, cityCode, vehicleTypeId: nextVehicleTypeId },
            effectiveFrom,
            effectiveTo,
            actor,
            existing.id,
          );
        }

        const latestInFamily = await tx.cancellationPolicy.aggregate({
          where: { familyId: existing.familyId },
          _max: { version: true },
        });
        const nextVersion = (latestInFamily._max.version ?? existing.version) + 1;

        const successor = await tx.cancellationPolicy.create({
          data: {
            ruleName,
            familyId: existing.familyId,
            version: nextVersion,
            supersedesId: existing.id,
            cancelledBy,
            minStatus,
            feeType,
            feeAmount,
            feeBase: body.feeBase ?? existing.feeBase,
            maxFee: body.maxFee !== undefined ? body.maxFee : existing.maxFee,
            freeCancelWindowSec: body.freeCancelWindowSec ?? existing.freeCancelWindowSec,
            driverCompensationType,
            driverCompensationAmount,
            driverPenaltyAmount:
              body.driverPenaltyAmount !== undefined
                ? body.driverPenaltyAmount
                : existing.driverPenaltyAmount,
            cityCode,
            vehicleTypeId: nextVehicleTypeId,
            effectiveFrom,
            effectiveTo,
            isActive,
            createdBy: actor.actorId,
          },
        });

        await recordAdminAction(tx, {
          ...actor,
          action: 'UPDATE',
          entityType: 'cancellation_policy',
          entityId: existing.id,
          summary: `Cancellation policy updated to v${nextVersion} (new row ${successor.id}, supersedes v${existing.version})`,
          before: existing,
          after: successor,
          result: 'SUCCESS',
        });

        return this.toDto(successor);
      });
    } catch (err) {
      if (isPgExclusionViolation(err)) {
        throw new CancellationPolicyConflictError(
          'An active cancellation policy already covers this scope and effective window.',
        );
      }
      throw err;
    }
  }

  async activate(id: string, actor: AuditActor): Promise<CancellationPolicyDto> {
    try {
      return await this.databaseService.transactionManager.execute(async (tx) => {
        const existing = await this.lockExisting(tx, id);
        const isExpired =
          existing.effectiveTo !== null && existing.effectiveTo.getTime() <= Date.now();
        const nextEffectiveFrom = isExpired ? new Date() : existing.effectiveFrom;
        const nextEffectiveTo = isExpired ? null : existing.effectiveTo;

        await this.applyTimeAwareExclusivity(
          tx,
          {
            cancelledBy: existing.cancelledBy,
            minStatus: existing.minStatus,
            cityCode: existing.cityCode,
            vehicleTypeId: existing.vehicleTypeId,
          },
          nextEffectiveFrom,
          nextEffectiveTo,
          actor,
          id,
        );
        const updated = await tx.cancellationPolicy.update({
          where: { id },
          data: {
            isActive: true,
            ...(isExpired
              ? { effectiveFrom: nextEffectiveFrom, effectiveTo: nextEffectiveTo }
              : {}),
          },
        });
        await this.audit(tx, actor, existing, updated, 'Cancellation policy activated');
        return this.toDto(updated);
      });
    } catch (err) {
      if (isPgExclusionViolation(err)) {
        throw new CancellationPolicyConflictError(
          'An active cancellation policy already covers this scope and effective window.',
        );
      }
      throw err;
    }
  }

  async deactivate(id: string, actor: AuditActor): Promise<CancellationPolicyDto> {
    return this.databaseService.transactionManager.execute(async (tx) => {
      const existing = await this.lockExisting(tx, id);
      const updated = await tx.cancellationPolicy.update({
        where: { id },
        data: { isActive: false },
      });
      await this.audit(tx, actor, existing, updated, 'Cancellation policy deactivated');
      return this.toDto(updated);
    });
  }

  async remove(id: string, actor: AuditActor): Promise<void> {
    await this.databaseService.transactionManager.execute(async (tx) => {
      const existing = await this.lockExisting(tx, id);

      if (existing.isActive) {
        throw new CancellationPolicyConflictError(
          'Deactivate this cancellation policy before deleting it.',
        );
      }

      const usedCount = await tx.rideCancellation.count({
        where: { policyId: id },
      });
      if (usedCount > 0) {
        throw new CancellationPolicyConflictError(
          `Cannot delete this cancellation policy because ${usedCount} historical ride cancellation record${usedCount === 1 ? '' : 's'} reference it for audit and settlement. Keep it inactive instead.`,
        );
      }

      await tx.cancellationPolicy.updateMany({
        where: { supersedesId: id },
        data: { supersedesId: existing.supersedesId ?? null },
      });

      await tx.cancellationPolicy.delete({
        where: { id },
      });

      await recordAdminAction(tx, {
        ...actor,
        action: 'DELETE',
        entityType: 'cancellation_policy',
        entityId: existing.id,
        summary: `Inactive cancellation policy v${existing.version} deleted (${existing.ruleName ?? existing.id})`,
        before: existing,
        result: 'SUCCESS',
      });
    });
  }

  private async lockExisting(tx: TransactionClient, id: string) {
    await lockForAudit(tx, 'cancellation_policies', id);
    const existing = await tx.cancellationPolicy.findUnique({ where: { id } });
    if (!existing) throw new CancellationPolicyNotFoundError();
    return existing;
  }

  private async audit(
    tx: TransactionClient,
    actor: AuditActor,
    before: { id: string },
    after: unknown,
    summary: string,
  ): Promise<void> {
    await recordAdminAction(tx, {
      ...actor,
      action: 'UPDATE',
      entityType: 'cancellation_policy',
      entityId: before.id,
      summary,
      before,
      after,
      result: 'SUCCESS',
    });
  }

  /// Enforces one active policy per (actor, scenario, city, vehicle type) at any instant:
  /// - If an overlapping incumbent started strictly earlier AND the incoming window starts
  ///   in the future, closes `incumbent.effectiveTo = incomingFrom` so the live policy
  ///   continues until handoff.
  /// - If an overlapping incumbent started at or earlier than an immediate activation,
  ///   deactivates the incumbent cleanly.
  /// - If an overlapping incumbent starts strictly in the future inside the incoming window,
  ///   aborts with `409 CANCELLATION_POLICY_CONFLICT` so scheduled rules are never silently clobbered.
  private async applyTimeAwareExclusivity(
    tx: TransactionClient,
    scope: {
      cancelledBy: string;
      minStatus: string | null;
      cityCode: string | null;
      vehicleTypeId: string | null;
    },
    incomingFrom: Date,
    incomingTo: Date | null,
    actor: AuditActor,
    exceptId?: string,
  ): Promise<void> {
    const activePeers = await tx.cancellationPolicy.findMany({
      where: {
        cancelledBy: scope.cancelledBy,
        minStatus: scope.minStatus,
        cityCode: scope.cityCode,
        vehicleTypeId: scope.vehicleTypeId,
        isActive: true,
        ...(exceptId !== undefined ? { NOT: { id: exceptId } } : {}),
      },
    });

    const overlapping = activePeers.filter((peer) =>
      windowsOverlap(peer.effectiveFrom, peer.effectiveTo, incomingFrom, incomingTo),
    );

    const nowMs = Date.now();
    for (const peer of overlapping) {
      if (peer.effectiveFrom.getTime() > incomingFrom.getTime()) {
        throw new CancellationPolicyConflictError(
          `Overlaps with scheduled policy ${peer.id} (v${peer.version}) starting at ${peer.effectiveFrom.toISOString()}.`,
        );
      }

      if (peer.effectiveFrom.getTime() < incomingFrom.getTime() && incomingFrom.getTime() > nowMs) {
        const closed = await tx.cancellationPolicy.update({
          where: { id: peer.id },
          data: { effectiveTo: incomingFrom },
        });
        await this.audit(
          tx,
          actor,
          peer,
          closed,
          `Cancellation policy window closed at ${incomingFrom.toISOString()} for scheduled successor`,
        );
      } else {
        const retired = await tx.cancellationPolicy.update({
          where: { id: peer.id },
          data: { isActive: false },
        });
        await this.audit(
          tx,
          actor,
          peer,
          retired,
          'Cancellation policy deactivated: superseded by another active policy',
        );
      }
    }
  }

  private toDto(row: {
    id: string;
    familyId: string;
    version: number;
    supersedesId: string | null;
    ruleName: string | null;
    cancelledBy: string;
    minStatus: string | null;
    feeAmount: { toString(): string };
    feeType: string;
    feeBase: string;
    maxFee: { toString(): string } | null;
    freeCancelWindowSec: number;
    driverCompensationType: string;
    driverCompensationAmount: { toString(): string };
    driverPenaltyAmount: { toString(): string } | null;
    isActive: boolean;
    effectiveFrom: Date;
    effectiveTo: Date | null;
    cityCode: string | null;
    vehicleTypeId: string | null;
    createdBy: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): CancellationPolicyDto {
    const actor = actorUi(row.cancelledBy);
    const scenario = scenarioUi(row.minStatus);
    const chargeType = feeUi(row.feeType);
    const feeBase =
      row.feeBase === 'BASE_FARE' || row.feeBase === 'MINIMUM_FARE' ? row.feeBase : 'QUOTED_FARE';
    const driverCompensationType =
      row.driverCompensationType === 'FLAT' || row.driverCompensationType === 'PERCENT_OF_FEE'
        ? row.driverCompensationType
        : 'NONE';

    return {
      id: row.id,
      familyId: row.familyId,
      version: row.version,
      supersedesId: row.supersedesId,
      ruleName: row.ruleName ?? `${actor} · ${scenario.replace(/_/g, ' ')}`,
      actor,
      scenario,
      chargeType,
      chargeAmount: toNum(row.feeAmount),
      feeBase,
      maxFee: row.maxFee !== null ? toNum(row.maxFee) : null,
      freeCancelWindowSec: row.freeCancelWindowSec,
      driverCompensationType,
      driverCompensationAmount: toNum(row.driverCompensationAmount),
      driverPenaltyAmount: row.driverPenaltyAmount !== null ? toNum(row.driverPenaltyAmount) : null,
      status: row.isActive ? 'active' : 'inactive',
      effectiveFrom: row.effectiveFrom.toISOString(),
      effectiveTo: row.effectiveTo ? row.effectiveTo.toISOString() : null,
      ...(row.cityCode ? { cityCode: row.cityCode } : {}),
      ...(row.vehicleTypeId ? { vehicleTypeId: row.vehicleTypeId } : {}),
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
