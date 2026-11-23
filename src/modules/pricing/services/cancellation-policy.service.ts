import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import { CANCELLATION_POLICY_ENFORCEMENT_FLAG, type FeatureFlagReader } from '../constants.js';

export type CancellationActorDb = 'RIDER' | 'DRIVER';
export type CancellationScenarioDb =
  'BEFORE_ASSIGNMENT' | 'AFTER_ASSIGNMENT' | 'AFTER_ARRIVAL' | 'NO_SHOW';
export type CancellationFeeTypeDb = 'FLAT' | 'PERCENT';
export type CancellationFeeBaseDb = 'QUOTED_FARE' | 'BASE_FARE' | 'MINIMUM_FARE';
export type DriverCompensationTypeDb = 'NONE' | 'FLAT' | 'PERCENT_OF_FEE';
export type CancellationFeeStatus = 'WAIVED' | 'ASSESSED' | 'COLLECTED' | 'DISPUTED' | 'REFUNDED';

export interface CancellationPolicyRecord {
  id: string;
  ruleName: string | null;
  familyId: string;
  version: number;
  cancelledBy: string;
  minStatus: string | null;
  cityCode: string | null;
  vehicleTypeId: string | null;
  freeCancelWindowSec: number;
  feeType: string;
  feeAmount: { toString(): string } | number;
  maxFee: { toString(): string } | number | null;
  feeBase: string;
  driverCompensationType: string;
  driverCompensationAmount: { toString(): string } | number;
  driverPenaltyAmount: { toString(): string } | number | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

export interface EvaluateCancellationInput {
  actor: 'CUSTOMER' | 'RIDER' | 'DRIVER' | 'SYSTEM';
  scenario: CancellationScenarioDb;
  cityCode?: string | null;
  vehicleTypeId?: string | null;
  elapsedSec: number;
  quotedFare?: number | null;
  baseFare?: number | null;
  minimumFare?: number | null;
  at?: Date;
}

export interface CancellationPolicySnapshot {
  enforcementMode: 'POLICY_ENGINE' | 'LEGACY_ENV_FALLBACK';
  policyId: string | null;
  familyId: string | null;
  policyVersion: number | null;
  ruleName: string | null;
  scopePriority: number;
  actor: string;
  scenario: CancellationScenarioDb;
  cityCode: string | null;
  vehicleTypeId: string | null;
  feeType: string | null;
  feeAmount: number;
  feeBase: string | null;
  maxFee: number | null;
  freeCancelWindowSec: number;
  driverCompensationType: string;
  driverCompensationAmount: number;
  driverPenaltyAmount: number | null;
  evaluation: {
    evaluatedAt: string;
    elapsedSec: number;
    withinGraceWindow: boolean;
    baseAmountUsed: number;
    rawFee: number;
    finalFee: number;
    driverCompensation: number;
    feeStatus: CancellationFeeStatus;
    reason: string;
  };
}

export interface CancellationEvaluationResult {
  matchedPolicy: {
    id: string;
    familyId: string;
    version: number;
    ruleName: string | null;
    cityCode: string | null;
    vehicleTypeId: string | null;
    scopePriority: number;
    freeCancelWindowSec: number;
    feeType: CancellationFeeTypeDb;
    feeAmount: number;
    maxFee: number | null;
    feeBase: CancellationFeeBaseDb;
    driverCompensationType: DriverCompensationTypeDb;
    driverCompensationAmount: number;
    driverPenaltyAmount: number | null;
  } | null;
  actor: 'RIDER' | 'DRIVER' | 'SYSTEM';
  scenario: CancellationScenarioDb;
  elapsedSec: number;
  freeCancelWindowSec: number;
  freeWindowRemainingSec: number;
  withinGraceWindow: boolean;
  baseAmountUsed: number;
  rawFee: number;
  cancellationFee: number;
  driverCompensation: number;
  feeStatus: CancellationFeeStatus;
  reason: string;
  snapshot: CancellationPolicySnapshot;
}

function round2(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value * 100) / 100;
}

function toNum(value: { toString(): string } | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === 'number' ? value : Number(value.toString());
}

export function normalizeActorToDb(
  actor: 'CUSTOMER' | 'RIDER' | 'DRIVER' | 'SYSTEM',
): 'RIDER' | 'DRIVER' | 'SYSTEM' {
  if (actor === 'SYSTEM') return 'SYSTEM';
  return actor === 'DRIVER' ? 'DRIVER' : 'RIDER';
}

/// Derives the canonical cancellation scenario from ride lifecycle state & reason code.
export function deriveCancellationScenario(input: {
  rideStatus?: string | null;
  arrivedAt?: Date | null;
  reasonCode?: string | null;
}): CancellationScenarioDb {
  if (!input.rideStatus) return 'BEFORE_ASSIGNMENT';

  const normalizedReason = (input.reasonCode ?? '').trim().toUpperCase();
  const hasArrived =
    input.rideStatus === 'DRIVER_ARRIVED' ||
    input.rideStatus === 'IN_PROGRESS' ||
    input.rideStatus === 'DRIVER_AT_DROPOFF' ||
    (input.arrivedAt !== null && input.arrivedAt !== undefined);

  if (
    hasArrived &&
    (normalizedReason === 'NO_SHOW' ||
      normalizedReason === 'CUSTOMER_NO_SHOW' ||
      normalizedReason === 'RIDER_NO_SHOW')
  ) {
    return 'NO_SHOW';
  }

  if (hasArrived) return 'AFTER_ARRIVAL';
  return 'AFTER_ASSIGNMENT';
}

/// 4-level deterministic scope priority:
/// 4 = City + Vehicle, 3 = City-wide, 2 = Global + Vehicle, 1 = Global default.
export function policyScopePriority(policy: {
  cityCode: string | null;
  vehicleTypeId: string | null;
}): number {
  if (policy.cityCode !== null && policy.vehicleTypeId !== null) return 4;
  if (policy.cityCode !== null) return 3;
  if (policy.vehicleTypeId !== null) return 2;
  return 1;
}

/// Pure deterministic ranker choosing the most specific active policy.
export function pickWinningCancellationPolicy<T extends CancellationPolicyRecord>(
  candidates: readonly T[],
): { policy: T; priority: number } | null {
  if (candidates.length === 0) return null;
  const sorted = [...candidates].sort((a, b) => {
    const prioDiff = policyScopePriority(b) - policyScopePriority(a);
    if (prioDiff !== 0) return prioDiff;
    const versionDiff = b.version - a.version;
    if (versionDiff !== 0) return versionDiff;
    const effDiff = b.effectiveFrom.getTime() - a.effectiveFrom.getTime();
    if (effDiff !== 0) return effDiff;
    return b.id.localeCompare(a.id);
  });
  const winner = sorted[0]!;
  return { policy: winner, priority: policyScopePriority(winner) };
}

/// Pure fee & driver-compensation assessment function (zero I/O, unit-testable).
export function computeCancellationAssessment(
  policy: CancellationPolicyRecord | null,
  scopePriority: number,
  input: EvaluateCancellationInput,
): CancellationEvaluationResult {
  const evaluatedAt = (input.at ?? new Date()).toISOString();
  const actorDb = normalizeActorToDb(input.actor);
  const elapsedSec = Math.max(
    0,
    Math.floor(Number.isFinite(input.elapsedSec) ? input.elapsedSec : 0),
  );

  if (actorDb === 'SYSTEM') {
    const snapshot: CancellationPolicySnapshot = {
      enforcementMode: 'POLICY_ENGINE',
      policyId: null,
      familyId: null,
      policyVersion: null,
      ruleName: null,
      scopePriority: 0,
      actor: actorDb,
      scenario: input.scenario,
      cityCode: input.cityCode ?? null,
      vehicleTypeId: input.vehicleTypeId ?? null,
      feeType: null,
      feeAmount: 0,
      feeBase: null,
      maxFee: null,
      freeCancelWindowSec: 0,
      driverCompensationType: 'NONE',
      driverCompensationAmount: 0,
      driverPenaltyAmount: null,
      evaluation: {
        evaluatedAt,
        elapsedSec,
        withinGraceWindow: true,
        baseAmountUsed: 0,
        rawFee: 0,
        finalFee: 0,
        driverCompensation: 0,
        feeStatus: 'WAIVED',
        reason: 'SYSTEM_CANCELLATION',
      },
    };
    return {
      matchedPolicy: null,
      actor: actorDb,
      scenario: input.scenario,
      elapsedSec,
      freeCancelWindowSec: 0,
      freeWindowRemainingSec: 0,
      withinGraceWindow: true,
      baseAmountUsed: 0,
      rawFee: 0,
      cancellationFee: 0,
      driverCompensation: 0,
      feeStatus: 'WAIVED',
      reason: 'SYSTEM_CANCELLATION',
      snapshot,
    };
  }

  if (!policy) {
    const snapshot: CancellationPolicySnapshot = {
      enforcementMode: 'POLICY_ENGINE',
      policyId: null,
      familyId: null,
      policyVersion: null,
      ruleName: null,
      scopePriority: 0,
      actor: actorDb,
      scenario: input.scenario,
      cityCode: input.cityCode ?? null,
      vehicleTypeId: input.vehicleTypeId ?? null,
      feeType: null,
      feeAmount: 0,
      feeBase: null,
      maxFee: null,
      freeCancelWindowSec: 0,
      driverCompensationType: 'NONE',
      driverCompensationAmount: 0,
      driverPenaltyAmount: null,
      evaluation: {
        evaluatedAt,
        elapsedSec,
        withinGraceWindow: false,
        baseAmountUsed: 0,
        rawFee: 0,
        finalFee: 0,
        driverCompensation: 0,
        feeStatus: 'WAIVED',
        reason: 'NO_ACTIVE_POLICY',
      },
    };
    return {
      matchedPolicy: null,
      actor: actorDb,
      scenario: input.scenario,
      elapsedSec,
      freeCancelWindowSec: 0,
      freeWindowRemainingSec: 0,
      withinGraceWindow: false,
      baseAmountUsed: 0,
      rawFee: 0,
      cancellationFee: 0,
      driverCompensation: 0,
      feeStatus: 'WAIVED',
      reason: 'NO_ACTIVE_POLICY',
      snapshot,
    };
  }

  const feeType: CancellationFeeTypeDb =
    policy.feeType.toUpperCase() === 'PERCENT' ? 'PERCENT' : 'FLAT';
  const feeAmount = round2(toNum(policy.feeAmount));
  const maxFee =
    policy.maxFee !== null && policy.maxFee !== undefined ? round2(toNum(policy.maxFee)) : null;
  const feeBase: CancellationFeeBaseDb =
    policy.feeBase === 'BASE_FARE' || policy.feeBase === 'MINIMUM_FARE'
      ? policy.feeBase
      : 'QUOTED_FARE';
  const driverCompType: DriverCompensationTypeDb =
    policy.driverCompensationType === 'FLAT' || policy.driverCompensationType === 'PERCENT_OF_FEE'
      ? policy.driverCompensationType
      : 'NONE';
  const driverCompAmount = round2(toNum(policy.driverCompensationAmount));
  const driverPenaltyAmount =
    policy.driverPenaltyAmount !== null && policy.driverPenaltyAmount !== undefined
      ? round2(toNum(policy.driverPenaltyAmount))
      : null;

  const freeWindowSec = Math.max(0, policy.freeCancelWindowSec);
  const withinGraceWindow = elapsedSec < freeWindowSec;
  const freeWindowRemainingSec = withinGraceWindow ? freeWindowSec - elapsedSec : 0;

  let baseAmountUsed = 0;
  let rawFee = 0;
  let finalFee = 0;
  let driverCompensation = 0;
  let reason = 'FEE_ASSESSED';

  if (withinGraceWindow) {
    reason = 'WITHIN_FREE_WINDOW';
  } else {
    if (feeBase === 'BASE_FARE') {
      baseAmountUsed = round2(input.baseFare ?? input.quotedFare ?? 0);
    } else if (feeBase === 'MINIMUM_FARE') {
      baseAmountUsed = round2(input.minimumFare ?? input.quotedFare ?? 0);
    } else {
      baseAmountUsed = round2(input.quotedFare ?? 0);
    }

    rawFee = feeType === 'PERCENT' ? round2((baseAmountUsed * feeAmount) / 100) : feeAmount;
    finalFee = maxFee !== null ? Math.min(rawFee, maxFee) : rawFee;

    if (finalFee <= 0) {
      finalFee = 0;
      reason = 'ZERO_FEE_POLICY';
    } else if (actorDb === 'RIDER') {
      if (driverCompType === 'FLAT') {
        driverCompensation = driverCompAmount;
      } else if (driverCompType === 'PERCENT_OF_FEE') {
        driverCompensation = round2((finalFee * driverCompAmount) / 100);
      }
    }
  }

  // Assessed only — never auto-collected in Phase 3 (collection gated on Finance D-07).
  const feeStatus: CancellationFeeStatus = finalFee > 0 ? 'ASSESSED' : 'WAIVED';

  const matchedPolicy = {
    id: policy.id,
    familyId: policy.familyId,
    version: policy.version,
    ruleName: policy.ruleName,
    cityCode: policy.cityCode,
    vehicleTypeId: policy.vehicleTypeId,
    scopePriority,
    freeCancelWindowSec: freeWindowSec,
    feeType,
    feeAmount,
    maxFee,
    feeBase,
    driverCompensationType: driverCompType,
    driverCompensationAmount: driverCompAmount,
    driverPenaltyAmount,
  };

  const snapshot: CancellationPolicySnapshot = {
    enforcementMode: 'POLICY_ENGINE',
    policyId: policy.id,
    familyId: policy.familyId,
    policyVersion: policy.version,
    ruleName: policy.ruleName,
    scopePriority,
    actor: actorDb,
    scenario: input.scenario,
    cityCode: policy.cityCode,
    vehicleTypeId: policy.vehicleTypeId,
    feeType,
    feeAmount,
    feeBase,
    maxFee,
    freeCancelWindowSec: freeWindowSec,
    driverCompensationType: driverCompType,
    driverCompensationAmount: driverCompAmount,
    driverPenaltyAmount,
    evaluation: {
      evaluatedAt,
      elapsedSec,
      withinGraceWindow,
      baseAmountUsed,
      rawFee,
      finalFee,
      driverCompensation,
      feeStatus,
      reason,
    },
  };

  return {
    matchedPolicy,
    actor: actorDb,
    scenario: input.scenario,
    elapsedSec,
    freeCancelWindowSec: freeWindowSec,
    freeWindowRemainingSec,
    withinGraceWindow,
    baseAmountUsed,
    rawFee,
    cancellationFee: finalFee,
    driverCompensation,
    feeStatus,
    reason,
    snapshot,
  };
}

export class CancellationPolicyService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly featureFlagService: FeatureFlagReader,
  ) {}

  async isEnforcementEnabled(): Promise<boolean> {
    return this.featureFlagService.isEnabledReadOnly(CANCELLATION_POLICY_ENFORCEMENT_FLAG);
  }

  async resolve(
    input: EvaluateCancellationInput,
    tx?: TransactionClient,
  ): Promise<CancellationEvaluationResult> {
    const actorDb = normalizeActorToDb(input.actor);
    if (actorDb === 'SYSTEM') {
      return computeCancellationAssessment(null, 0, input);
    }

    const at = input.at ?? new Date();
    const client = tx ?? this.databaseService.client;

    const cityFilter = input.cityCode
      ? [{ cityCode: input.cityCode }, { cityCode: null }]
      : [{ cityCode: null }];
    const vehicleFilter = input.vehicleTypeId
      ? [{ vehicleTypeId: input.vehicleTypeId }, { vehicleTypeId: null }]
      : [{ vehicleTypeId: null }];

    const candidates = await client.cancellationPolicy.findMany({
      where: {
        cancelledBy: actorDb,
        minStatus: input.scenario,
        isActive: true,
        effectiveFrom: { lte: at },
        AND: [
          { OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }] },
          { OR: cityFilter },
          { OR: vehicleFilter },
        ],
      },
    });

    const winner = pickWinningCancellationPolicy(candidates);
    return computeCancellationAssessment(winner?.policy ?? null, winner?.priority ?? 0, input);
  }
}
