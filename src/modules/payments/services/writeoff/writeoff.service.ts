import { paymentConfig } from '@config';
import { RedisService } from '@core/cache/RedisService.js';
import { DatabaseService, TransactionManager } from '@core/database';
import { EventPublisher } from '@core/events';
import { RideFareRepository } from '@modules/rides/repositories/ride-fare.repository.js';
import { RidePaymentRepository } from '../../repositories/ride-payment.repository.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { paymentEvent, PAYMENT_EVENT_CATALOG } from '../../events/catalog.js';
import { PaymentMetrics } from '../../metrics/payment.metrics.js';

export type WriteOffResult = 'WRITTEN_OFF' | 'NOT_ELIGIBLE' | 'ALREADY_WRITTEN_OFF';

/// BD-1c — ageing an uncollectable receivable off the books.
///
/// This is the only place `BAD_DEBT_EXPENSE` is ever recognised. The
/// receivable is created optimistically when collection is exhausted, because
/// at that moment the platform is still owed the money; booking the loss then
/// would understate what it expects to recover. The loss is recognised here,
/// once the debt has been outstanding long enough to be worth giving up on.
export class WriteOffService {
  constructor(
    private readonly db: DatabaseService,
    private readonly ridePaymentRepository: RidePaymentRepository,
    private readonly rideFareRepository: RideFareRepository,
    private readonly ledgerService: LedgerService,
    private readonly txManager: TransactionManager,
    private readonly eventPublisher: EventPublisher,
    private readonly redis: RedisService,
    private readonly paymentMetrics: PaymentMetrics,
  ) {}

  /// Receivables old enough to write off. Ordered oldest-first so a backlog
  /// drains in the order the debts were incurred.
  async findAgedReceivables(now: Date, limit: number): Promise<{ id: string }[]> {
    const cutoff = new Date(now.getTime() - paymentConfig.receivableWriteOffDays * 86_400_000);
    return this.db.client.$queryRaw<{ id: string }[]>`
      SELECT r."id"
      FROM "rides" r
      WHERE r."payment_status" = 'FAILED'
        AND r."completed_at" <= ${cutoff}
        AND NOT EXISTS (
          SELECT 1 FROM "ride_payments" p
          WHERE p."ride_id" = r."id" AND p."status" IN ('WRITTEN_OFF', 'SUCCEEDED')
        )
      ORDER BY r."completed_at" ASC
      LIMIT ${limit}
    `;
  }

  /// Transition 8 — one transaction, every precondition re-checked inside it.
  ///
  /// The row is locked and re-read because a rider can settle a receivable at
  /// any moment (transition 7b): a ride that qualified when the sweep listed
  /// it may have been paid by the time this runs, and writing off a debt
  /// somebody just cleared would credit `CUSTOMER_RECEIVABLE` twice. A
  /// duplicate write-off is separately impossible — the partial unique index
  /// allows one `WRITTEN_OFF` row per ride — but relying on a constraint
  /// violation as flow control would still lose the ledger group.
  async writeOff(rideId: string): Promise<WriteOffResult> {
    // The same per-ride lock collection uses. A rider may be mid-settlement
    // right now, with the provider already charged and the transaction not yet
    // open; writing the debt off underneath that would take their money for a
    // ride the platform had just given up on. Not eligible today is a fine
    // answer — this job runs again tomorrow.
    const resource = `payment:collect:${rideId}`;
    const token = await this.redis.lock.acquire(resource, 30_000);
    if (!token) return 'NOT_ELIGIBLE';
    try {
      return await this.writeOffLocked(rideId);
    } finally {
      await this.redis.lock.release(resource, token);
    }
  }

  private async writeOffLocked(rideId: string): Promise<WriteOffResult> {
    return this.txManager.execute(async (tx) => {
      const locked = await tx.$queryRaw<{ payment_status: string; customer_id: string }[]>`
        SELECT "payment_status", "customer_id" FROM "rides"
        WHERE "id" = ${rideId}::uuid FOR UPDATE
      `;
      const ride = locked[0];
      if (!ride || ride.payment_status !== 'FAILED') return 'NOT_ELIGIBLE';
      if (await this.ridePaymentRepository.findWrittenOffForRide(rideId, tx)) {
        return 'ALREADY_WRITTEN_OFF';
      }
      // A late collection wins: the debt was recovered, so there is no loss.
      if (await this.ridePaymentRepository.findSucceededForRide(rideId, tx)) return 'NOT_ELIGIBLE';
      const fare = await this.rideFareRepository.findByRideId(rideId, tx);
      if (!fare) return 'NOT_ELIGIBLE';

      await this.ridePaymentRepository.create(
        { rideId, amount: fare.totalFare, method: 'WRITE_OFF', status: 'WRITTEN_OFF' },
        tx,
      );
      await this.ledgerService.postTransactionGroup(
        [
          {
            account: 'BAD_DEBT_EXPENSE',
            direction: 'DEBIT',
            amount: fare.totalFare,
            referenceType: 'RIDE',
            referenceId: rideId,
            description: `Uncollectable fare written off for ride ${rideId}`,
          },
          {
            account: 'CUSTOMER_RECEIVABLE',
            accountRefId: ride.customer_id,
            direction: 'CREDIT',
            amount: fare.totalFare,
            referenceType: 'RIDE',
            referenceId: rideId,
            description: `Receivable written off for ride ${rideId}`,
          },
        ],
        tx,
      );
      this.paymentMetrics.receivableWrittenOff({ rideId });
      // For finance and audit. There is deliberately no rider notification:
      // telling customers their unpaid rides eventually stop mattering is an
      // instruction on how to game the platform.
      await this.eventPublisher.publish(
        paymentEvent(PAYMENT_EVENT_CATALOG.RECEIVABLE_WRITTEN_OFF, rideId, {
          rideId,
          customerId: ride.customer_id,
          amount: fare.totalFare.toNumber(),
        }),
        tx,
      );
      return 'WRITTEN_OFF';
    });
  }
}
