import { rideConfig } from '@config';
import type { TransactionClient } from '@core/database/TransactionManager';
// Direct file imports, not the '@modules/pricing' barrel: the barrel also loads
// the fiscal-document ride-completed consumer, which imports the rides event
// catalog and so leads back here before CancellationService is defined.
import {
  CancellationPolicyService,
  deriveCancellationScenario,
  type CancellationFeeStatus,
  type CancellationPolicySnapshot,
  type CancellationScenarioDb,
} from '@modules/pricing/services/cancellation-policy.service.js';
import type { PricingSnapshot } from '@modules/pricing/domain/pricing.types.js';
import type { Prisma } from '../../../../generated/prisma/index.js';
import { Decimal } from '../../types/index.js';
import { RideCancellationRepository } from '../../repositories/ride-cancellation.repository.js';
import { RideRequestRepository } from '../../repositories/ride-request.repository.js';
import type { Ride, RideCancellation } from '../../types';

export interface CancellationQuoteResult {
  rideId: string;
  rideStatus: string;
  actor: 'CUSTOMER' | 'DRIVER' | 'SYSTEM';
  scenario: CancellationScenarioDb;
  enforcementEnabled: boolean;
  policyId: string | null;
  policyVersion: number | null;
  freeCancelWindowSec: number;
  elapsedSec: number;
  freeWindowRemainingSec: number;
  withinGraceWindow: boolean;
  estimatedFee: number;
  driverCompensationPreview: number;
  feeStatusPreview: CancellationFeeStatus;
  currency: 'INR';
  reason: string;
  snapshot: CancellationPolicySnapshot;
}

function readSnapshotPricingContext(
  quotedFare: { toString(): string } | number | null | undefined,
  rawSnapshot: unknown,
): {
  cityCode: string | null;
  quotedFare: number;
  baseFare: number | null;
  minimumFare: number | null;
} {
  const snap =
    rawSnapshot && typeof rawSnapshot === 'object' ? (rawSnapshot as Partial<PricingSnapshot>) : null;
  const quoted = quotedFare !== null && quotedFare !== undefined ? Number(quotedFare.toString()) : 0;
  const cityCode =
    typeof snap?.cityCode === 'string' && snap.cityCode.trim() && snap.cityCode !== 'GLOBAL'
      ? snap.cityCode.trim()
      : null;
  const baseFare = typeof snap?.rateCard?.baseFare === 'number' ? snap.rateCard.baseFare : null;
  const minimumFare =
    typeof snap?.rateCard?.minimumFare === 'number' ? snap.rateCard.minimumFare : null;

  return {
    cityCode,
    quotedFare: Number.isFinite(quoted) ? quoted : 0,
    baseFare,
    minimumFare,
  };
}

export class CancellationService {
  constructor(
    private readonly cancellationRepo: RideCancellationRepository,
    private readonly requestRepo?: RideRequestRepository,
    private readonly cancellationPolicyService?: CancellationPolicyService,
  ) {}

  /// Computes the exact cancellation fee assessment for a ride. Shared by both
  /// `GET /api/v1/rides/:id/cancellation-quote` and `processCancellation` so the
  /// preview shown to the caller always matches the row persisted on cancel.
  async quoteCancellation(
    data: {
      ride: Ride;
      actor: 'CUSTOMER' | 'DRIVER' | 'SYSTEM';
      reasonCode?: string;
      at?: Date;
    },
    tx?: TransactionClient,
  ): Promise<CancellationQuoteResult> {
    const at = data.at ?? new Date();
    const scenario = deriveCancellationScenario({
      rideStatus: data.ride.status,
      arrivedAt: data.ride.arrivedAt,
      reasonCode: data.reasonCode ?? null,
    });

    const enforcementEnabled = this.cancellationPolicyService
      ? await this.cancellationPolicyService.isEnforcementEnabled()
      : false;

    if (enforcementEnabled && this.cancellationPolicyService) {
      const request = this.requestRepo
        ? await this.requestRepo.findById(data.ride.requestId, tx)
        : null;
      const pricingCtx = readSnapshotPricingContext(
        request?.quotedFare,
        request?.pricingSnapshot,
      );

      const anchorTime =
        (scenario === 'AFTER_ARRIVAL' || scenario === 'NO_SHOW') && data.ride.arrivedAt
          ? data.ride.arrivedAt
          : data.ride.acceptedAt;
      const elapsedSec = Math.max(0, Math.floor((at.getTime() - anchorTime.getTime()) / 1000));

      const evaluation = await this.cancellationPolicyService.resolve(
        {
          actor: data.actor,
          scenario,
          cityCode: pricingCtx.cityCode,
          vehicleTypeId: data.ride.vehicleTypeId,
          elapsedSec,
          quotedFare: pricingCtx.quotedFare,
          baseFare: pricingCtx.baseFare,
          minimumFare: pricingCtx.minimumFare,
          at,
        },
        tx,
      );

      return {
        rideId: data.ride.id,
        rideStatus: data.ride.status,
        actor: data.actor,
        scenario,
        enforcementEnabled: true,
        policyId: evaluation.matchedPolicy?.id ?? null,
        policyVersion: evaluation.matchedPolicy?.version ?? null,
        freeCancelWindowSec: evaluation.freeCancelWindowSec,
        elapsedSec: evaluation.elapsedSec,
        freeWindowRemainingSec: evaluation.freeWindowRemainingSec,
        withinGraceWindow: evaluation.withinGraceWindow,
        estimatedFee: evaluation.cancellationFee,
        driverCompensationPreview: evaluation.driverCompensation,
        feeStatusPreview: evaluation.feeStatus,
        currency: 'INR',
        reason: evaluation.reason,
        snapshot: evaluation.snapshot,
      };
    }

    // Legacy env-driven fallback when `cancellation.policy_enforcement` is OFF (default).
    const graceWindowSec = rideConfig.cancellationGraceMinutes * 60;
    const elapsedSec = Math.max(0, Math.floor((at.getTime() - data.ride.acceptedAt.getTime()) / 1000));
    const graceEndsAt = new Date(data.ride.acceptedAt.getTime() + graceWindowSec * 1000);
    const withinGraceWindow = at < graceEndsAt;
    const freeWindowRemainingSec = withinGraceWindow
      ? Math.max(0, Math.ceil((graceEndsAt.getTime() - at.getTime()) / 1000))
      : 0;
    const feeApplies =
      data.actor === 'CUSTOMER' &&
      !withinGraceWindow &&
      (data.ride.status === 'DRIVER_ARRIVED' ||
        data.ride.status === 'IN_PROGRESS' ||
        data.ride.status === 'DRIVER_AT_DROPOFF' ||
        data.ride.arrivedAt !== null);
    const estimatedFee = feeApplies ? rideConfig.defaultCancellationFee : 0;
    const feeStatusPreview: CancellationFeeStatus = estimatedFee > 0 ? 'ASSESSED' : 'WAIVED';
    const reason =
      data.actor === 'SYSTEM'
        ? 'SYSTEM_CANCELLATION'
        : withinGraceWindow
          ? 'WITHIN_FREE_WINDOW'
          : feeApplies
            ? 'LEGACY_FLAT_FEE'
            : 'NO_FEE_FOR_STATE';

    const snapshot: CancellationPolicySnapshot = {
      enforcementMode: 'LEGACY_ENV_FALLBACK',
      policyId: null,
      familyId: null,
      policyVersion: null,
      ruleName: null,
      scopePriority: 0,
      actor: data.actor === 'CUSTOMER' ? 'RIDER' : data.actor,
      scenario,
      cityCode: null,
      vehicleTypeId: data.ride.vehicleTypeId,
      feeType: 'FLAT',
      feeAmount: rideConfig.defaultCancellationFee,
      feeBase: null,
      maxFee: null,
      freeCancelWindowSec: graceWindowSec,
      driverCompensationType: 'NONE',
      driverCompensationAmount: 0,
      driverPenaltyAmount: null,
      evaluation: {
        evaluatedAt: at.toISOString(),
        elapsedSec,
        withinGraceWindow,
        baseAmountUsed: 0,
        rawFee: estimatedFee,
        finalFee: estimatedFee,
        driverCompensation: 0,
        feeStatus: feeStatusPreview,
        reason,
      },
    };

    return {
      rideId: data.ride.id,
      rideStatus: data.ride.status,
      actor: data.actor,
      scenario,
      enforcementEnabled: false,
      policyId: null,
      policyVersion: null,
      freeCancelWindowSec: graceWindowSec,
      elapsedSec,
      freeWindowRemainingSec,
      withinGraceWindow,
      estimatedFee,
      driverCompensationPreview: 0,
      feeStatusPreview,
      currency: 'INR',
      reason,
      snapshot,
    };
  }

  /// Records the assessed cancellation fee, driver compensation preview, and immutable
  /// policy snapshot on `ride_cancellations`.
  ///
  /// Does **not** collect money (`feeCharged: false`, `feeStatus: 'ASSESSED' | 'WAIVED'`) —
  /// actual collection and driver disbursement stay gated on Finance Decision D-07.
  async processCancellation(
    data: {
      ride: Ride;
      cancelledAt: Date;
      cancelledBy: 'CUSTOMER' | 'DRIVER' | 'SYSTEM';
      actorId?: string;
      reasonCode: string;
      reasonText?: string;
    },
    tx?: TransactionClient,
  ): Promise<RideCancellation> {
    const quote = await this.quoteCancellation(
      {
        ride: data.ride,
        actor: data.cancelledBy,
        reasonCode: data.reasonCode,
        at: data.cancelledAt,
      },
      tx,
    );

    return this.cancellationRepo.create(
      {
        rideId: data.ride.id,
        cancelledBy: data.cancelledBy,
        actorId: data.actorId ?? null,
        reasonCode: data.reasonCode,
        reasonText: data.reasonText ?? null,
        cancelledAtStatus: data.ride.status,
        cancellationFee: new Decimal(quote.estimatedFee),
        driverCompensation: new Decimal(quote.driverCompensationPreview),
        // Assessed only, never collected here — financial collection gated on Finance D-07.
        feeCharged: false,
        feeStatus: quote.feeStatusPreview,
        policyId: quote.policyId,
        policyVersion: quote.policyVersion,
        policySnapshot: quote.snapshot as unknown as Prisma.InputJsonValue,
      },
      tx,
    );
  }
}
