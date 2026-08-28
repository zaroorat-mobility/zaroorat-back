import { rideConfig } from '@config';
import { Decimal } from '../../types/index.js';
import { RideCancellationRepository } from '../../repositories/ride-cancellation.repository.js';
import type { Ride, RideCancellation } from '../../types';
import type { TransactionClient } from '@core/database/TransactionManager';
export class CancellationService {
  constructor(private readonly cancellationRepo: RideCancellationRepository) {}
  /// Records what a cancellation cost the customer. It does **not** collect it,
  /// and `feeCharged` says so.
  ///
  /// Collecting cancellation fees is an explicit non-goal of the payment
  /// feature, not an omission: `specs/002-payment-fare-settlement/spec.md`
  /// lists them under out-of-scope, `data-model.md` records that the tables
  /// "exist, remain unwritten", and `decisions.md` scopes the collection path
  /// to `ride.status = 'COMPLETED'` — "never a cancelled or in-progress ride".
  /// `RideCollectionService` is built to that: it reads its amount from
  /// `RideFare.totalFare`, and a cancelled ride has no fare row.
  ///
  /// This wrote `feeCharged: true` anyway, so every fee-bearing cancellation
  /// left a row asserting money had been taken that nothing had taken — the
  /// same class of untrue record FR-038 removed from the ledger. Nothing reads
  /// the row today (`findByRideId` has no callers), so the lie was latent
  /// rather than harmful; it would have surfaced on the first finance query or
  /// support screen to look.
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
    // `RIDE_CANCELLATION_GRACE_MIN` existed, defaulted to the 2 minutes the
    // industry converged on, was validated at boot — and was read by nothing, so
    // a customer who changed their mind seconds after a driver accepted was
    // assessed the full fee the moment that driver reached them. Measured from
    // the accept because that is when the customer's commitment begins; a short
    // pickup that arrives inside the window is still free, which is the point.
    const graceEndsAt = new Date(
      data.ride.acceptedAt.getTime() + rideConfig.cancellationGraceMinutes * 60_000,
    );
    // `cancelledAt` rather than the clock: this runs inside the transaction that
    // just stamped it, and the fee should follow the recorded time.
    const withinGrace = data.cancelledAt < graceEndsAt;
    const feeApplies =
      data.cancelledBy === 'CUSTOMER' &&
      !withinGrace &&
      (data.ride.status === 'DRIVER_ARRIVED' || data.ride.arrivedAt !== null);
    // Was a hardcoded 50 while `RIDE_DEFAULT_CANCELLATION_FEE` — which exists
    // for exactly this and defaults to the same 50 — went unread, so an
    // operator changing it changed nothing.
    const cancellationFee = new Decimal(feeApplies ? rideConfig.defaultCancellationFee : 0);
    return this.cancellationRepo.create(
      {
        rideId: data.ride.id,
        cancelledBy: data.cancelledBy,
        actorId: data.actorId ?? null,
        reasonCode: data.reasonCode,
        reasonText: data.reasonText ?? null,
        cancelledAtStatus: data.ride.status,
        cancellationFee,
        // Assessed, never collected — see above. Whatever eventually charges
        // these is what gets to set this true, in the same transaction that
        // takes the money.
        feeCharged: false,
      },
      tx,
    );
  }
}
