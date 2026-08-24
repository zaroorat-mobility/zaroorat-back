import { RideReceiptRepository } from '../../repositories/ride-receipt.repository.js';
import { RideRepository } from '../../repositories/ride.repository.js';
import { RidePaymentRepository } from '@modules/payments/repositories/ride-payment.repository.js';
import { projectCollectionState } from '@modules/payments/services/collection/collection-state.js';
import { Decimal } from '../../types/index.js';
import { RideNotFoundError } from '../../errors/ride.errors.js';
import type { RideReceipt } from '../../types';
import type { TransactionClient } from '@core/database/TransactionManager';
export class ReceiptService {
  constructor(
    private readonly receiptRepo: RideReceiptRepository,
    private readonly rideRepo: RideRepository,
    private readonly ridePaymentRepository: RidePaymentRepository,
  ) {}
  /// Idempotent by design: an existing receipt is returned untouched.
  ///
  /// That is what makes it safe to call from the collection transaction *and*
  /// still leave the lazy `GET` path working for rides that predate it — and
  /// it is what makes a receipt immutable. A later refund or a settled
  /// receivable does not rewrite what this ride's receipt says; those are
  /// their own events with their own records.
  async generateReceipt(rideId: string, tx?: TransactionClient): Promise<RideReceipt> {
    const existing = await this.receiptRepo.findByRideId(rideId, tx);
    if (existing) return existing;
    const ride = await this.rideRepo.findById(rideId, tx);
    if (!ride) throw new RideNotFoundError(rideId);
    const fare = (ride as { fare?: { totalFare?: Decimal } | null }).fare ?? null;
    const attempts = await this.ridePaymentRepository.findByRideId(rideId, tx);
    const succeeded = attempts.find((attempt) => attempt.status === 'SUCCEEDED');
    const snapshotJson = {
      rideId: ride.id,
      rideCode: ride.rideCode,
      customerId: ride.customerId,
      driverId: ride.driverId,
      status: ride.status,
      paymentMethod: ride.paymentMethod,
      fare,
      /// How the ride was paid, in the public vocabulary. Never
      /// `Ride.paymentStatus`: that column says `FAILED` for a standing debt,
      /// and a receipt is a client-facing document (FR-041).
      payment: {
        method: ride.paymentMethod,
        status: projectCollectionState({
          paymentStatus: ride.paymentStatus,
          method: ride.paymentMethod,
          attempts,
          totalFare: fare?.totalFare ?? new Decimal(0),
        }).collectionState,
        settledAt: succeeded?.settledAt?.toISOString() ?? null,
      },
      issuedAt: new Date().toISOString(),
    };
    return this.receiptRepo.create(rideId, snapshotJson, null, tx);
  }
}
