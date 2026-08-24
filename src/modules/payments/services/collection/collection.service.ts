import { cashConfirmationRequired, paymentConfig } from '@config';
import { TransactionManager } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import { EventPublisher } from '@core/events';
import { RedisService } from '@core/cache/RedisService.js';
import { logger } from '@shared/logger/index.js';
import { RideRepository } from '@modules/rides/repositories/ride.repository.js';
import { RideFareRepository } from '@modules/rides/repositories/ride-fare.repository.js';
import { ReceiptService } from '@modules/rides/services/receipt/receipt.service.js';
import { Decimal } from '../../types/index.js';
import { RidePaymentRepository } from '../../repositories/ride-payment.repository.js';
import { SettlementWalletRepository } from '../../repositories/settlement-wallet.repository.js';
import { PaymentGatewayProvider } from '../gateway/gateway.provider.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { WalletService } from '../wallet/wallet.service.js';
import { InsufficientBalanceError } from '../../errors/payment.errors.js';
import { paymentEvent, PAYMENT_EVENT_CATALOG } from '../../events/catalog.js';
import { PaymentMetrics } from '../../metrics/payment.metrics.js';

export type CollectionResult =
  'COLLECTED' | 'RETRYING' | 'RECEIVABLE' | 'ALREADY_SETTLED' | 'NOT_COLLECTABLE' | 'BUSY';

/// Charges a completed ride, exactly once.
///
/// The amount is read from `RideFare.totalFare` and from nowhere else. No
/// request body reaches this service, and it recomputes nothing — a fare is
/// priced once, at completion, and collection copies it.
export class RideCollectionService {
  constructor(
    private readonly rideRepository: RideRepository,
    private readonly rideFareRepository: RideFareRepository,
    private readonly ridePaymentRepository: RidePaymentRepository,
    private readonly walletService: WalletService,
    private readonly settlementWalletRepository: SettlementWalletRepository,
    private readonly receiptService: ReceiptService,
    private readonly ledgerService: LedgerService,
    private readonly paymentGatewayProvider: PaymentGatewayProvider,
    private readonly txManager: TransactionManager,
    private readonly eventPublisher: EventPublisher,
    private readonly redis: RedisService,
    private readonly paymentMetrics: PaymentMetrics,
  ) {}

  /// Serialized per ride so the sweep, the completion consumer and a rider's
  /// own retry cannot all charge at once.
  ///
  /// The lock is **not** the correctness boundary — a lost lock, an expired
  /// TTL or a Redis outage must not be able to double-charge anyone. That
  /// guarantee comes from the conditional `paymentStatus` claim and the
  /// partial unique index on one `SUCCEEDED` attempt per ride. This only
  /// avoids wasted work and duplicate provider calls.
  async collect(rideId: string): Promise<CollectionResult> {
    const resource = `payment:collect:${rideId}`;
    const token = await this.redis.lock.acquire(resource, 30_000);
    if (!token) return 'BUSY';
    try {
      return await this.attempt(rideId);
    } finally {
      await this.redis.lock.release(resource, token);
    }
  }

  private async attempt(rideId: string): Promise<CollectionResult> {
    const ride = await this.rideRepository.findById(rideId);
    if (!ride) return 'NOT_COLLECTABLE';
    // PAID or FAILED both mean the obligation has already reached an outcome.
    // Settling a standing receivable is transition 7b and goes through
    // `settleReceivable`, not through here.
    if (ride.paymentStatus !== 'PENDING') return 'ALREADY_SETTLED';
    // A cash ride is settled in the completion transaction while BD-5's flag
    // is off (transition 4c). With the flag on it waits on a driver, not on
    // this service.
    if (ride.paymentMethod === 'CASH') return 'NOT_COLLECTABLE';

    const fare = await this.rideFareRepository.findByRideId(rideId);
    if (!fare) return 'NOT_COLLECTABLE';

    const failedSoFar = await this.ridePaymentRepository.countAttempts(rideId);

    const charged = await this.charge(ride.paymentMethod, fare.totalFare, rideId, failedSoFar);
    if (!charged.ok) {
      return this.recordFailure(rideId, ride, fare, failedSoFar, charged.reason);
    }
    try {
      return await this.recordSuccess(rideId, ride, fare, charged.reference);
    } catch (err) {
      // A wallet has no provider to decline it, so its only decline surfaces
      // as this — thrown inside the transaction above, which rolls the claim
      // back with it. That leaves the obligation exactly where a card decline
      // would: still PENDING, and one attempt poorer.
      if (!(err instanceof InsufficientBalanceError)) throw err;
      return this.recordFailure(rideId, ride, fare, failedSoFar, 'insufficient_balance');
    }
  }

  /// Transitions 4a and 4b — a cash ride is acknowledged.
  ///
  /// 4a is a driver saying so, 4b is the grace period expiring; they are the
  /// same transaction and differ only in what the ledger description records,
  /// so an auditor can tell an acknowledgement from a timeout. Running both at
  /// once is safe: the conditional claim picks one winner and the other
  /// becomes a no-op.
  ///
  /// `expectedDriverId` is how the manual path proves the caller is the driver
  /// on this ride. The automatic path passes none.
  async confirmCash(
    rideId: string,
    options: { expectedDriverId?: string; automatic?: boolean } = {},
  ): Promise<CollectionResult> {
    // Condition 1 of BD-6: with the flag off this flow does not exist at all.
    if (!cashConfirmationRequired()) return 'NOT_COLLECTABLE';
    const resource = `payment:collect:${rideId}`;
    const token = await this.redis.lock.acquire(resource, 30_000);
    if (!token) return 'BUSY';
    try {
      const ride = await this.rideRepository.findById(rideId);
      // Conditions 2, 3 and 4.
      if (!ride) return 'NOT_COLLECTABLE';
      if (ride.paymentMethod !== 'CASH') return 'NOT_COLLECTABLE';
      if (ride.status !== 'COMPLETED') return 'NOT_COLLECTABLE';
      if (ride.paymentStatus !== 'PENDING') return 'ALREADY_SETTLED';
      if (options.expectedDriverId != null && ride.driverId !== options.expectedDriverId) {
        return 'NOT_COLLECTABLE';
      }
      // Condition 5.
      if (await this.ridePaymentRepository.findSucceededForRide(rideId)) return 'ALREADY_SETTLED';
      const fare = await this.rideFareRepository.findByRideId(rideId);
      if (!fare) return 'NOT_COLLECTABLE';

      const how = options.automatic ? 'automatically after the grace period' : 'by the driver';
      return await this.txManager.execute(async (tx) => {
        // Re-checked inside the claiming transaction, so a sweep racing a
        // driver's tap cannot both post the commission.
        if (!(await this.rideRepository.claimPaymentStatusIf(rideId, 'PENDING', 'PAID', tx))) {
          return 'ALREADY_SETTLED';
        }
        await this.ridePaymentRepository.create(
          {
            rideId,
            amount: fare.totalFare,
            method: 'CASH',
            status: 'SUCCEEDED',
            settledAt: new Date(),
          },
          tx,
        );
        if (fare.platformCommission.gt(0)) {
          // The driver is holding the whole fare, so the platform's share is
          // owed back. This is allowed to push the balance negative — that
          // negative is the debt, and the next settlement clears it.
          await this.settlementWalletRepository.debit(
            {
              driverId: ride.driverId,
              amount: fare.platformCommission,
              referenceType: 'RIDE',
              referenceId: rideId,
              description: `Commission on cash ride ${rideId}, confirmed ${how}`,
            },
            tx,
          );
          await this.ledgerService.postTransactionGroup(
            [
              {
                account: 'DRIVER_PAYABLE',
                accountRefId: ride.driverId,
                direction: 'DEBIT',
                amount: fare.platformCommission,
                referenceType: 'RIDE',
                referenceId: rideId,
                description: `Commission owed on cash ride ${rideId}, confirmed ${how}`,
              },
              {
                account: 'PLATFORM_COMMISSION',
                direction: 'CREDIT',
                amount: fare.platformCommission,
                referenceType: 'RIDE',
                referenceId: rideId,
                description: `Platform commission for cash ride ${rideId}, confirmed ${how}`,
              },
            ],
            tx,
          );
        }
        await this.receiptService.generateReceipt(rideId, tx);
        this.paymentMetrics.collectionSucceeded({ rideId, method: 'CASH' });
        if (options.automatic === true) this.paymentMetrics.cashAutoResolved({ rideId });
        await this.eventPublisher.publish(
          paymentEvent(PAYMENT_EVENT_CATALOG.RIDE_COLLECTED, rideId, {
            rideId,
            customerId: ride.customerId,
            driverId: ride.driverId,
            amount: fare.totalFare.toNumber(),
            method: 'CASH',
            commissionOwed: fare.platformCommission.toNumber(),
            automatic: options.automatic === true,
          }),
          tx,
        );
        return 'COLLECTED';
      });
    } finally {
      await this.redis.lock.release(resource, token);
    }
  }

  /// Transition 7b — a rider settles a standing receivable.
  ///
  /// **This is not transition 3 with a different starting state.** Earnings
  /// and commission were already recognised when the receivable was created,
  /// so this group moves the balancing side only: the fare arrives and the
  /// receivable clears. Posting the full group here would credit
  /// `DRIVER_PAYABLE` and `PLATFORM_COMMISSION` a second time and double-count
  /// one ride's earnings and revenue — which is exactly what BD-4 means by
  /// "settles the existing obligation without creating another obligation".
  async settleReceivable(rideId: string): Promise<CollectionResult> {
    const resource = `payment:collect:${rideId}`;
    const token = await this.redis.lock.acquire(resource, 30_000);
    if (!token) return 'BUSY';
    try {
      const ride = await this.rideRepository.findById(rideId);
      if (!ride) return 'NOT_COLLECTABLE';
      if (ride.paymentStatus !== 'FAILED') return 'ALREADY_SETTLED';
      if (await this.ridePaymentRepository.findWrittenOffForRide(rideId)) return 'NOT_COLLECTABLE';
      const fare = await this.rideFareRepository.findByRideId(rideId);
      if (!fare) return 'NOT_COLLECTABLE';

      const failedSoFar = await this.ridePaymentRepository.countAttempts(rideId);
      const charged = await this.charge(ride.paymentMethod, fare.totalFare, rideId, failedSoFar);
      if (!charged.ok) return 'RECEIVABLE';

      try {
        return await this.txManager.execute(async (tx) => {
          // Same row lock the write-off takes, so the two serialize. Without
          // it both could pass their own pre-checks and the ride would end up
          // with a SUCCEEDED *and* a WRITTEN_OFF row — the claim alone cannot
          // catch this, because a write-off deliberately leaves the obligation
          // at FAILED (transition 8) rather than moving it.
          await this.rideRepository.lockForUpdate(rideId, tx);
          if (await this.ridePaymentRepository.findWrittenOffForRide(rideId, tx)) {
            return 'NOT_COLLECTABLE';
          }
          if (!(await this.rideRepository.claimPaymentStatusIf(rideId, 'FAILED', 'PAID', tx))) {
            return 'ALREADY_SETTLED';
          }
          if (ride.paymentMethod === 'WALLET') {
            await this.walletService.debitInTx(ride.customerId, fare.totalFare, tx, {
              referenceType: 'RIDE',
              referenceId: rideId,
              description: `Settlement of unpaid fare for ride ${rideId}`,
            });
          }
          await this.ridePaymentRepository.create(
            {
              rideId,
              amount: fare.totalFare,
              method: ride.paymentMethod,
              status: 'SUCCEEDED',
              settledAt: new Date(),
            },
            tx,
          );
          await this.ledgerService.postTransactionGroup(
            [
              {
                account: ride.paymentMethod === 'WALLET' ? 'CUSTOMER_WALLET' : 'GATEWAY_CLEARING',
                ...(ride.paymentMethod === 'WALLET' ? { accountRefId: ride.customerId } : {}),
                direction: 'DEBIT',
                amount: fare.totalFare,
                referenceType: 'RIDE',
                referenceId: rideId,
                description: `Settlement of unpaid fare for ride ${rideId}`,
              },
              {
                account: 'CUSTOMER_RECEIVABLE',
                accountRefId: ride.customerId,
                direction: 'CREDIT',
                amount: fare.totalFare,
                referenceType: 'RIDE',
                referenceId: rideId,
                description: `Receivable cleared for ride ${rideId}`,
              },
            ],
            tx,
          );
          await this.eventPublisher.publish(
            paymentEvent(PAYMENT_EVENT_CATALOG.RIDE_COLLECTED, rideId, {
              rideId,
              customerId: ride.customerId,
              driverId: ride.driverId,
              amount: fare.totalFare.toNumber(),
              method: ride.paymentMethod,
              settledReceivable: true,
            }),
            tx,
          );
          return 'COLLECTED';
        });
      } catch (err) {
        if (!(err instanceof InsufficientBalanceError)) throw err;
        return 'RECEIVABLE';
      }
    } finally {
      await this.redis.lock.release(resource, token);
    }
  }

  /// Talks to the provider, **outside any transaction**.
  ///
  /// A gateway call inside a transaction holds a database connection open for
  /// the length of a network round trip to a third party, and a timeout would
  /// roll back work that the provider has already performed.
  private async charge(
    method: string,
    amount: Decimal,
    rideId: string,
    attemptIndex: number,
  ): Promise<{ ok: true; reference: string | null } | { ok: false; reason: string }> {
    // A wallet debit is our own database row; there is no provider to call.
    if (method === 'WALLET') return { ok: true, reference: null };
    try {
      const intent = await this.paymentGatewayProvider.createIntent({
        amount,
        currency: 'INR',
        // Deterministic from the ride and which attempt this is, so a
        // redelivered event replays the *same* charge at the provider rather
        // than raising a second one, while a genuine later retry is allowed to
        // be a new charge.
        idempotencyKey: `ride-collect:${rideId}:${attemptIndex}`,
        metadata: { rideId },
      });
      const confirmed = await this.paymentGatewayProvider.confirmIntent(intent.gatewayIntentId);
      return confirmed.status === 'SUCCEEDED'
        ? { ok: true, reference: intent.gatewayIntentId }
        : { ok: false, reason: `gateway_${confirmed.status.toLowerCase()}` };
    } catch (err) {
      logger.warn({ err, rideId }, '[payments] gateway declined ride collection');
      return { ok: false, reason: 'gateway_error' };
    }
  }

  /// Transitions 2 and 3 — one transaction, claim first.
  private async recordSuccess(
    rideId: string,
    ride: { customerId: string; driverId: string; paymentMethod: string },
    fare: { totalFare: Decimal; driverEarning: Decimal; platformCommission: Decimal },
    reference: string | null,
  ): Promise<CollectionResult> {
    return this.txManager.execute(async (tx) => {
      // The claim comes first so that a loser does no work at all: it cannot
      // debit a wallet, cannot post a ledger group, cannot announce anything.
      if (!(await this.rideRepository.claimPaymentStatusIf(rideId, 'PENDING', 'PAID', tx))) {
        return 'ALREADY_SETTLED';
      }
      if (ride.paymentMethod === 'WALLET') {
        await this.walletService.debitInTx(ride.customerId, fare.totalFare, tx, {
          referenceType: 'RIDE',
          referenceId: rideId,
          description: `Fare for ride ${rideId}`,
        });
      }
      await this.ridePaymentRepository.create(
        {
          rideId,
          amount: fare.totalFare,
          method: ride.paymentMethod,
          status: 'SUCCEEDED',
          paymentId: null,
          settledAt: new Date(),
        },
        tx,
      );
      await this.ledgerService.recordTripPayment(
        {
          totalFare: fare.totalFare,
          driverPayable: fare.driverEarning,
          platformCommission: fare.platformCommission,
          customerUserId: ride.customerId,
          driverId: ride.driverId,
          rideId,
          paymentMethod: ride.paymentMethod,
        },
        tx,
      );
      // FR-023 — the receipt is issued at the payment outcome, in the same
      // transaction, rather than improvised the first time somebody asks for
      // one. A ride nobody opens still has a receipt.
      await this.receiptService.generateReceipt(rideId, tx);
      this.paymentMetrics.collectionSucceeded({ rideId, method: ride.paymentMethod });
      await this.eventPublisher.publish(
        paymentEvent(PAYMENT_EVENT_CATALOG.RIDE_COLLECTED, rideId, {
          rideId,
          customerId: ride.customerId,
          driverId: ride.driverId,
          amount: fare.totalFare.toNumber(),
          method: ride.paymentMethod,
          gatewayReference: reference,
        }),
        tx,
      );
      return 'COLLECTED';
    });
  }

  /// Transition 5 while budget remains, transition 6 once it is gone.
  ///
  /// Both write the failed attempt row; only the terminal one creates the
  /// receivable. `collection_failed` with `willRetry: false` **is** the
  /// receivable-establishing signal — it is published in the same transaction
  /// as the `CUSTOMER_RECEIVABLE` debit, which is why there is no separate
  /// debt event describing the same transition twice.
  private async recordFailure(
    rideId: string,
    ride: { customerId: string; driverId: string },
    fare: { totalFare: Decimal; driverEarning: Decimal; platformCommission: Decimal },
    failedSoFar: number,
    reason: string,
  ): Promise<CollectionResult> {
    const willRetry = failedSoFar + 1 < paymentConfig.collectionMaxAttempts;
    return this.txManager.execute(async (tx) => {
      await this.ridePaymentRepository.create(
        { rideId, amount: fare.totalFare, method: 'RETRY', status: 'FAILED' },
        tx,
      );
      if (!willRetry) {
        // A loser here has nothing to undo — the attempt row above is an
        // append-only audit fact and stays true either way.
        if (await this.rideRepository.claimPaymentStatusIf(rideId, 'PENDING', 'FAILED', tx)) {
          await this.postReceivable(rideId, ride, fare, tx);
          // The ride is over and the outcome is settled even though nothing
          // was collected: the rider owes, and the receipt records that.
          await this.receiptService.generateReceipt(rideId, tx);
        }
      }
      this.paymentMetrics.collectionFailed({ rideId, willRetry, reason });
      if (!willRetry) this.paymentMetrics.receivableCreated({ rideId });
      await this.eventPublisher.publish(
        paymentEvent(PAYMENT_EVENT_CATALOG.RIDE_COLLECTION_FAILED, rideId, {
          rideId,
          customerId: ride.customerId,
          amount: fare.totalFare.toNumber(),
          attempt: failedSoFar + 1,
          willRetry,
          reason,
        }),
        tx,
      );
      return willRetry ? 'RETRYING' : 'RECEIVABLE';
    });
  }

  /// BD-1 option C: an uncollected fare is an asset the customer still owes,
  /// not a loss. The driver is paid and the commission recognised all the
  /// same — the driver drove the trip, and whether the rider paid is the
  /// platform's problem, not theirs. Bad debt is recognised only at write-off.
  private async postReceivable(
    rideId: string,
    ride: { customerId: string; driverId: string },
    fare: { totalFare: Decimal; driverEarning: Decimal; platformCommission: Decimal },
    tx: TransactionClient,
  ): Promise<void> {
    await this.ledgerService.postTransactionGroup(
      [
        {
          account: 'CUSTOMER_RECEIVABLE',
          accountRefId: ride.customerId,
          direction: 'DEBIT',
          amount: fare.totalFare,
          referenceType: 'RIDE',
          referenceId: rideId,
          description: `Uncollected fare for ride ${rideId}`,
        },
        ...(fare.driverEarning.gt(0)
          ? ([
              {
                account: 'DRIVER_PAYABLE',
                accountRefId: ride.driverId,
                direction: 'CREDIT' as const,
                amount: fare.driverEarning,
                referenceType: 'RIDE',
                referenceId: rideId,
                description: `Driver earnings for ride ${rideId}`,
              },
            ] as const)
          : []),
        ...(fare.platformCommission.gt(0)
          ? ([
              {
                account: 'PLATFORM_COMMISSION',
                direction: 'CREDIT' as const,
                amount: fare.platformCommission,
                referenceType: 'RIDE',
                referenceId: rideId,
                description: `Platform commission for ride ${rideId}`,
              },
            ] as const)
          : []),
      ],
      tx,
    );
  }
}
