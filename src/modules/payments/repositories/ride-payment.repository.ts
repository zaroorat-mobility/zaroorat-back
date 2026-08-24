import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import { Decimal } from '../types/index.js';
import type { RidePayment } from '../types';

/// Attempt-level status. Deliberately a plain string union rather than a
/// Prisma enum: `ride_payments.status` is a `String` column, so `WRITTEN_OFF`
/// needed no schema migration.
///
/// Note the vocabulary trap this feature exists to remove — attempt-level
/// `FAILED` means "this one attempt did not collect", which is a different
/// fact from obligation-level `Ride.paymentStatus = FAILED` ("the customer
/// still owes"). Neither is ever surfaced to a client; the public API uses a
/// derived `collectionState` instead.
export type RidePaymentStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'WRITTEN_OFF';

export interface CreateRidePaymentInput {
  rideId: string;
  amount: Decimal;
  method: string;
  status: RidePaymentStatus;
  paymentId?: string | null;
  settledAt?: Date | null;
}

/// Owns every write to `ride_payments`.
///
/// Lives in `payments` rather than `rides` even though the table is declared
/// in `prisma/schema/modules/ride/` — financial mutation belongs to this
/// module, the same boundary `SettlementWalletRepository` documents for
/// `driver_wallets`.
export class RidePaymentRepository {
  constructor(private readonly db: DatabaseService) {}

  async create(input: CreateRidePaymentInput, tx?: TransactionClient): Promise<RidePayment> {
    const client = tx ?? this.db.client;
    return client.ridePayment.create({
      data: {
        rideId: input.rideId,
        amount: input.amount,
        method: input.method,
        status: input.status,
        ...(input.paymentId !== undefined ? { paymentId: input.paymentId } : {}),
        ...(input.settledAt !== undefined ? { settledAt: input.settledAt } : {}),
      },
    });
  }

  /// Every attempt for a ride, newest first. Attempt rows are append-only, so
  /// this is the audit trail of what was tried and when.
  async findByRideId(rideId: string, tx?: TransactionClient): Promise<RidePayment[]> {
    const client = tx ?? this.db.client;
    return client.ridePayment.findMany({
      where: { rideId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /// The winning attempt, if collection has succeeded. At most one can exist —
  /// enforced by the partial unique index, not by this query.
  async findSucceededForRide(rideId: string, tx?: TransactionClient): Promise<RidePayment | null> {
    const client = tx ?? this.db.client;
    return client.ridePayment.findFirst({ where: { rideId, status: 'SUCCEEDED' } });
  }

  /// Present only once the receivable has been aged out (BD-1c). Its existence
  /// is what turns the public `collectionState` from `UNPAID` to `WRITTEN_OFF`
  /// and closes the obligation to further retries.
  async findWrittenOffForRide(rideId: string, tx?: TransactionClient): Promise<RidePayment | null> {
    const client = tx ?? this.db.client;
    return client.ridePayment.findFirst({ where: { rideId, status: 'WRITTEN_OFF' } });
  }

  /// Failed attempts so far. Compared against the configured cap to decide
  /// whether a ride is still `RETRYING` or has become a standing receivable.
  async countAttempts(rideId: string, tx?: TransactionClient): Promise<number> {
    const client = tx ?? this.db.client;
    return client.ridePayment.count({ where: { rideId, status: 'FAILED' } });
  }

  /// Rides the collection sweep should try again: still owed, last attempt
  /// older than the backoff window. Ordered oldest-first so a backlog drains
  /// fairly rather than starving the earliest failures.
  ///
  /// Uses the `(status, created_at)` index added alongside this repository.
  async findRetryable(before: Date, limit: number, tx?: TransactionClient): Promise<RidePayment[]> {
    const client = tx ?? this.db.client;
    return client.ridePayment.findMany({
      where: { status: 'FAILED', createdAt: { lte: before } },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
  }
}
