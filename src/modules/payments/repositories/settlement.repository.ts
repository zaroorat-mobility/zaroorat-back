import { Decimal } from '../types/index.js';
import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { DriverSettlement } from '../types';
export class SettlementRepository {
  constructor(private readonly db: DatabaseService) {}
  async create(
    data: {
      driverId: string;
      periodStart: Date;
      periodEnd: Date;
      grossEarnings: Decimal;
      commission: Decimal;
      adjustments: Decimal;
      netPayable: Decimal;
    },
    tx?: TransactionClient,
  ): Promise<DriverSettlement> {
    const client = tx ?? this.db.client;
    return client.driverSettlement.create({
      data: {
        driverId: data.driverId,
        periodStart: data.periodStart,
        periodEnd: data.periodEnd,
        grossEarnings: data.grossEarnings,
        commission: data.commission,
        adjustments: data.adjustments,
        netPayable: data.netPayable,
        status: 'PENDING',
      },
    });
  }
  async findByDriverAndPeriod(
    driverId: string,
    periodStart: Date,
    periodEnd: Date,
    tx?: TransactionClient,
  ): Promise<DriverSettlement | null> {
    const client = tx ?? this.db.client;
    return client.driverSettlement.findUnique({
      where: {
        driverId_periodStart_periodEnd: {
          driverId,
          periodStart,
          periodEnd,
        },
      },
    });
  }
  /// The driver's earnings basis for a period, derived from `ride_fares` and
  /// nothing else.
  ///
  /// **It must never join `ride_payments`.** BD-1 forbids deducting a
  /// customer's payment failure from what a driver earned: the driver drove
  /// the trip, and whether the rider paid is the platform's problem. A
  /// settlement query that filtered on collection success would be a defect,
  /// not an optimisation — the shortfall belongs in `CUSTOMER_RECEIVABLE`.
  ///
  /// Cash is filtered out of the fare basis for a different reason entirely:
  /// the driver is already holding that money, so there is nothing to pay
  /// them. Only the commission they owe on it belongs in the settlement.
  async aggregateEarnings(
    driverId: string,
    periodStart: Date,
    periodEnd: Date,
    tx?: TransactionClient,
  ): Promise<{
    collectedFare: Decimal;
    commission: Decimal;
    driverEarning: Decimal;
    /// FR-006. What the platform owes the driver for rides it collected itself.
    earnedOnCollected: Decimal;
    /// Commission on those same rides — the platform's share of the money it
    /// already holds, which is never paid out and never owed back.
    commissionOnCollected: Decimal;
    /// FR-006. What the driver owes back for rides they took the cash on: the
    /// whole fare less their earning, which is commission **plus** the tax and
    /// the platform fee they are also holding.
    owedOnCash: Decimal;
    rideCount: number;
  }> {
    const client = tx ?? this.db.client;
    const rows = await client.$queryRaw<
      {
        collected_fare: Decimal | null;
        commission: Decimal | null;
        driver_earning: Decimal | null;
        earned_on_collected: Decimal | null;
        commission_on_collected: Decimal | null;
        owed_on_cash: Decimal | null;
        ride_count: bigint;
      }[]
    >`
      SELECT
        COALESCE(SUM(f."total_fare") FILTER (WHERE r."payment_method" <> 'CASH'), 0)
          AS collected_fare,
        COALESCE(SUM(f."platform_commission"), 0) AS commission,
        COALESCE(SUM(f."driver_earning"), 0)      AS driver_earning,
        COALESCE(
          SUM(f."driver_earning") FILTER (WHERE r."payment_method" <> 'CASH'), 0
        ) AS earned_on_collected,
        COALESCE(
          SUM(f."platform_commission") FILTER (WHERE r."payment_method" <> 'CASH'), 0
        ) AS commission_on_collected,
        COALESCE(
          SUM(f."total_fare" - f."driver_earning")
            FILTER (WHERE r."payment_method" = 'CASH'), 0
        ) AS owed_on_cash,
        COUNT(*)                                  AS ride_count
      FROM "rides" r
      JOIN "ride_fares" f ON f."ride_id" = r."id"
      WHERE r."driver_id" = ${driverId}::uuid
        AND r."status" = 'COMPLETED'::"RideStatus"
        AND r."completed_at" >= ${periodStart}
        AND r."completed_at" <  ${periodEnd}
    `;
    const row = rows[0];
    return {
      collectedFare: new Decimal(row?.collected_fare ?? 0),
      commission: new Decimal(row?.commission ?? 0),
      driverEarning: new Decimal(row?.driver_earning ?? 0),
      earnedOnCollected: new Decimal(row?.earned_on_collected ?? 0),
      commissionOnCollected: new Decimal(row?.commission_on_collected ?? 0),
      owedOnCash: new Decimal(row?.owed_on_cash ?? 0),
      rideCount: Number(row?.ride_count ?? 0),
    };
  }
  /// Drivers who completed at least one fared ride in the window — the input
  /// `calculateSettlement` needs but nothing previously produced (the job used
  /// to require an explicit, externally-supplied driver list).
  async findDriverIdsWithCompletedRides(
    periodStart: Date,
    periodEnd: Date,
    tx?: TransactionClient,
  ): Promise<string[]> {
    const client = tx ?? this.db.client;
    const rows = await client.ride.findMany({
      where: {
        status: 'COMPLETED',
        completedAt: { gte: periodStart, lt: periodEnd },
      },
      select: { driverId: true },
      distinct: ['driverId'],
    });
    return rows.map((row) => row.driverId);
  }
  async lockForUpdate(id: string, tx: TransactionClient): Promise<DriverSettlement | null> {
    const locked = await tx.$queryRaw<
      {
        id: string;
      }[]
    >`
      SELECT "id" FROM "driver_settlements" WHERE "id" = ${id}::uuid FOR UPDATE
    `;
    if (locked.length === 0) return null;
    return tx.driverSettlement.findUnique({ where: { id } });
  }
  async updateStatus(
    id: string,
    status: string,
    tx?: TransactionClient,
  ): Promise<DriverSettlement> {
    const client = tx ?? this.db.client;
    return client.driverSettlement.update({
      where: { id },
      data: { status },
    });
  }

  /// The driver's cumulative position across every settlement so far.
  ///
  /// Each row's `netPayable` already includes whatever it carried in, so the
  /// running sum is the outstanding balance: negative means a past period
  /// ended owing and has not been worked off yet.
  async cumulativeNetPayable(driverId: string, tx?: TransactionClient): Promise<Decimal> {
    const client = tx ?? this.db.client;
    const rows = await client.$queryRaw<{ total: Decimal | null }[]>`
      SELECT COALESCE(SUM("net_payable"), 0) AS total
      FROM "driver_settlements"
      WHERE "driver_id" = ${driverId}::uuid
    `;
    return new Decimal(rows[0]?.total ?? 0);
  }

  /// Commission already taken out of the driver's wallet at cash confirmation
  /// (BD-5), which the settlement must therefore not net a second time.
  ///
  /// Deliberately separate from `aggregateEarnings` rather than a filter
  /// inside it: this is about *cash commission recovery*, and putting a
  /// `ride_payments` reference in the earnings query — even a correct one —
  /// invites the next reader to add the one BD-1 forbids.
  async alreadyRecoveredCommission(
    driverId: string,
    periodStart: Date,
    periodEnd: Date,
    tx?: TransactionClient,
  ): Promise<Decimal> {
    const client = tx ?? this.db.client;
    const rows = await client.$queryRaw<{ recovered: Decimal | null }[]>`
      -- FR-006. The cash confirmation now debits the driver's settlement wallet
      -- for the whole platform share, not the commission alone, so what has
      -- already been recovered is that same amount.
      SELECT COALESCE(SUM(f."total_fare" - f."driver_earning"), 0) AS recovered
      FROM "rides" r
      JOIN "ride_fares" f ON f."ride_id" = r."id"
      WHERE r."driver_id" = ${driverId}::uuid
        AND r."payment_method" = 'CASH'
        AND r."status" = 'COMPLETED'::"RideStatus"
        AND r."completed_at" >= ${periodStart}
        AND r."completed_at" <  ${periodEnd}
        AND EXISTS (
          SELECT 1 FROM "ride_payments" p
          WHERE p."ride_id" = r."id" AND p."status" = 'SUCCEEDED'
        )
    `;
    return new Decimal(rows[0]?.recovered ?? 0);
  }
}
