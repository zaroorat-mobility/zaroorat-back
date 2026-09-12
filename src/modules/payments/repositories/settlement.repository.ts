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
  /// Cash — and CARD/UPI, which mean the same thing here: the customer paid
  /// the driver directly, never the platform — is filtered out of the fare
  /// basis for a different reason entirely: the driver is already holding
  /// that money, so there is nothing to pay them. What they owe back on it
  /// belongs in the settlement — tax and the platform fee always; commission
  /// too, but only for a ride with no payment model (COMMISSION/SUBSCRIPTION
  /// own their commission entirely through their own mechanism, never
  /// through settlement). WALLET is the only method excluded from this
  /// filter — the one case where the platform actually held the fare.
  async aggregateEarnings(
    driverId: string,
    periodStart: Date,
    periodEnd: Date,
    tx?: TransactionClient,
  ): Promise<{
    collectedFare: Decimal;
    /// FR-006. What the platform owes the driver for rides it collected
    /// itself — including, for a ride with a payment model, the
    /// commission-sized amount redistributed to the driver in the ledger
    /// (see `LedgerService.recordTripPayment`), since that ride's commission
    /// was already collected elsewhere and does not reduce this driver's pay.
    earnedOnCollected: Decimal;
    /// Commission on those same rides — the platform's share of the money it
    /// already holds, which is never paid out and never owed back.
    commissionOnCollected: Decimal;
    /// FR-006. What the driver owes back for rides they took the cash on: tax
    /// and the platform fee they're holding, always — plus commission too,
    /// but only for a ride with no payment model (a COMMISSION/SUBSCRIPTION
    /// ride's commission is never settlement's to recover).
    owedOnCash: Decimal;
    /// The slice of `owedOnCash` that is actually commission rather than tax
    /// + the platform fee — nonzero only for a legacy, no-payment-model ride
    /// (where `owedOnCash` is the whole undifferentiated platform share, kept
    /// for backward compatibility). A payment-model ride's cash debt is tax +
    /// fee only, so it contributes nothing here: this is what lets the
    /// settlement's `commission` figure stay commission, never a mislabelled
    /// tax/fee debt.
    commissionOwedOnCash: Decimal;
  }> {
    const client = tx ?? this.db.client;
    const rows = await client.$queryRaw<
      {
        collected_fare: Decimal | null;
        earned_on_collected: Decimal | null;
        commission_on_collected: Decimal | null;
        owed_on_cash: Decimal | null;
        commission_owed_on_cash: Decimal | null;
      }[]
    >`
      SELECT
        COALESCE(SUM(f."total_fare") FILTER (WHERE r."payment_method" = 'WALLET'), 0)
          AS collected_fare,
        -- Redistributed, not discarded, for the same reason
        -- LedgerService.recordTripPayment redistributes it into the
        -- DRIVER_PAYABLE credit rather than dropping it: a ride with a
        -- payment model owns its commission entirely elsewhere, so the
        -- driver — not the platform a second time — is who receives the
        -- fare's commission-sized component. This sum must match what the
        -- ledger actually credited, or settlement would pay out less than
        -- the books already promised the driver.
        COALESCE(
          SUM(
            f."driver_earning" +
              CASE WHEN r."driver_payment_model" IS NULL THEN 0 ELSE f."platform_commission" END
          ) FILTER (WHERE r."payment_method" = 'WALLET'), 0
        ) AS earned_on_collected,
        COALESCE(
          SUM(f."platform_commission")
            FILTER (WHERE r."payment_method" = 'WALLET' AND r."driver_payment_model" IS NULL), 0
        ) AS commission_on_collected,
        -- Cash (and CARD/UPI, paid straight to the driver) still owes back
        -- the tax and the platform fee it's holding regardless — only the
        -- commission component is excluded for a ride with a payment model.
        COALESCE(
          SUM(
            CASE WHEN r."driver_payment_model" IS NULL
              THEN f."total_fare" - f."driver_earning"
              ELSE f."total_fare" - f."driver_earning" - f."platform_commission"
            END
          ) FILTER (WHERE r."payment_method" <> 'WALLET'), 0
        ) AS owed_on_cash,
        -- Same legacy/payment-model split as owed_on_cash, but keeping only
        -- the commission-labelled slice: the whole owed amount for a legacy
        -- ride (backward compatibility), zero for a payment-model ride (whose
        -- cash debt is tax + fee only, never commission).
        COALESCE(
          SUM(
            CASE WHEN r."driver_payment_model" IS NULL THEN f."total_fare" - f."driver_earning" ELSE 0 END
          ) FILTER (WHERE r."payment_method" <> 'WALLET'), 0
        ) AS commission_owed_on_cash
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
      earnedOnCollected: new Decimal(row?.earned_on_collected ?? 0),
      commissionOnCollected: new Decimal(row?.commission_on_collected ?? 0),
      owedOnCash: new Decimal(row?.owed_on_cash ?? 0),
      commissionOwedOnCash: new Decimal(row?.commission_owed_on_cash ?? 0),
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

  /// The platform's share already taken out of the driver's settlement wallet
  /// at cash confirmation (BD-5, extended to CARD/UPI — the customer paying
  /// the driver directly by any of the three) — tax and the platform fee
  /// always, plus commission too but only for a legacy, no-payment-model ride
  /// — which the settlement must therefore not net a second time. Never the
  /// Commission Wallet: a payment-model ride's commission is never recovered
  /// through cash confirmation at all, so there is nothing of that ride's
  /// commission for this method to have already recovered.
  ///
  /// Deliberately separate from `aggregateEarnings` rather than a filter
  /// inside it: this is about recovery already performed at cash
  /// confirmation, and putting a `ride_payments` reference in the earnings
  /// query — even a correct one — invites the next reader to add the one
  /// BD-1 forbids.
  async alreadyRecoveredCommission(
    driverId: string,
    periodStart: Date,
    periodEnd: Date,
    tx?: TransactionClient,
  ): Promise<{ recovered: Decimal; commissionRecovered: Decimal }> {
    const client = tx ?? this.db.client;
    const rows = await client.$queryRaw<
      { recovered: Decimal | null; commission_recovered: Decimal | null }[]
    >`
      -- FR-006. The cash confirmation now debits the driver's settlement wallet
      -- for the whole platform share, not the commission alone, so what has
      -- already been recovered is that same amount.
      --
      -- 004-driver-subscription-wallet. A ride with a payment model never has
      -- its commission recovered through cash confirmation at all
      -- (RideCollectionService.confirmCash / LifecycleService.completeRide's
      -- immediate cash-settle path both exclude it) — so what it actually
      -- recovered there, and therefore what must not be netted again here, is
      -- tax and platform fee only. commission_recovered isolates the slice
      -- of recovered that is actually commission rather than tax + fee —
      -- nonzero only for a legacy, no-payment-model ride — so the settlement's
      -- commission figure never absorbs a payment-model ride's tax/fee debt.
      SELECT
        COALESCE(SUM(
          CASE WHEN r."driver_payment_model" IS NULL
            THEN f."total_fare" - f."driver_earning"
            ELSE f."total_fare" - f."driver_earning" - f."platform_commission"
          END
        ), 0) AS recovered,
        COALESCE(SUM(
          CASE WHEN r."driver_payment_model" IS NULL THEN f."total_fare" - f."driver_earning" ELSE 0 END
        ), 0) AS commission_recovered
      FROM "rides" r
      JOIN "ride_fares" f ON f."ride_id" = r."id"
      WHERE r."driver_id" = ${driverId}::uuid
        AND r."payment_method" <> 'WALLET'
        AND r."status" = 'COMPLETED'::"RideStatus"
        AND r."completed_at" >= ${periodStart}
        AND r."completed_at" <  ${periodEnd}
        AND EXISTS (
          SELECT 1 FROM "ride_payments" p
          WHERE p."ride_id" = r."id" AND p."status" = 'SUCCEEDED'
        )
    `;
    return {
      recovered: new Decimal(rows[0]?.recovered ?? 0),
      commissionRecovered: new Decimal(rows[0]?.commission_recovered ?? 0),
    };
  }
}
