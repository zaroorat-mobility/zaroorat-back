import { paymentConfig } from '@config';
import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import { Decimal } from '../../types/index.js';

export interface RiderDebt {
  outstanding: Decimal;
  limit: Decimal;
  blocked: boolean;
}

/// What a rider or a driver currently owes.
///
/// A read model, not a table. There is no debt column anywhere: a rider's
/// outstanding balance is the sum of the fares on their unpaid rides, and a
/// driver's is whatever their wallet has gone negative by. Storing either
/// would be a second source of truth for a number the money path already
/// determines, and the two would drift the first time a settlement committed
/// without updating the copy.
export class DebtService {
  constructor(private readonly db: DatabaseService) {}

  /// Open receivables only. A written-off ride is closed (BD-1c) and must not
  /// keep counting against someone forever.
  async riderOutstanding(userId: string, tx?: TransactionClient): Promise<Decimal> {
    const client = tx ?? this.db.client;
    const rows = await client.$queryRaw<{ outstanding: Decimal | null }[]>`
      SELECT COALESCE(SUM(f."total_fare"), 0) AS outstanding
      FROM "rides" r
      JOIN "ride_fares" f ON f."ride_id" = r."id"
      WHERE r."customer_id" = ${userId}::uuid
        AND r."payment_status" = 'FAILED'
        AND NOT EXISTS (
          SELECT 1 FROM "ride_payments" p
          WHERE p."ride_id" = r."id" AND p."status" = 'WRITTEN_OFF'
        )
    `;
    return new Decimal(rows[0]?.outstanding ?? 0);
  }

  /// BD-2. The comparison is `>=` — *reaches or exceeds* the limit.
  ///
  /// Computed on every check and never cached, so it cannot be stale, and
  /// never taken from a request: a client that could name its own debt would
  /// name zero.
  async riderDebt(userId: string, tx?: TransactionClient): Promise<RiderDebt> {
    const outstanding = await this.riderOutstanding(userId, tx);
    const limit = new Decimal(paymentConfig.riderDebtLimit);
    return { outstanding, limit, blocked: outstanding.gte(limit) };
  }

  /// A driver's outstanding commission: the amount their wallet has gone
  /// negative by, or zero.
  ///
  /// Deliberately returns no limit and no blocked flag. BD-3 approved *no
  /// driver blocking* — a driver's commission balance never gates their work,
  /// and a `blocked` field here would be an invitation to start.
  async driverOutstanding(driverId: string, tx?: TransactionClient): Promise<Decimal> {
    const client = tx ?? this.db.client;
    const wallet = await client.driverWallet.findUnique({ where: { driverId } });
    if (!wallet || wallet.balance.gte(0)) return new Decimal(0);
    return wallet.balance.neg();
  }
}
