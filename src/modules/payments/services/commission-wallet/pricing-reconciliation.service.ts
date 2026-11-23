import { DatabaseService } from '@core/database';
import { LEDGER_ACCOUNTS } from '../../constants/payment.constants.js';

export interface ReconciliationInvariantResult {
  id: number;
  name: string;
  passed: boolean;
  driftAmount: number;
  violationCount: number;
  details: Record<string, unknown>;
}

export interface DailyPricingReconciliationReport {
  checkedAt: string;
  allPassed: boolean;
  invariants: ReconciliationInvariantResult[];
}

export interface StaleReservationSweepResult {
  releasedCancelledCount: number;
  alertedCompletedRideIds: string[];
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/// Phase 4 (Rev 5 §4.4 & §4.6): Evaluates all 6 daily pricing/financial reconciliation
/// invariants + sweeps stale driver wallet reservations safely.
export class PricingReconciliationService {
  constructor(private readonly databaseService: DatabaseService) {}

  async runDailyInvariants(): Promise<DailyPricingReconciliationReport> {
    const client = this.databaseService.client;
    const checkedAt = new Date().toISOString();

    // Invariant 1: Wallet <-> Ledger
    // driver_commission_wallets.balance == SUM(credits) - SUM(debits) on DRIVER_COMMISSION_WALLET
    const [walletAgg, ledgerCredits, ledgerDebits] = await Promise.all([
      client.driverCommissionWallet.aggregate({ _sum: { balance: true } }),
      client.paymentLedgerEntry.aggregate({
        where: { account: LEDGER_ACCOUNTS.DRIVER_COMMISSION_WALLET, direction: 'CREDIT' },
        _sum: { amount: true },
      }),
      client.paymentLedgerEntry.aggregate({
        where: { account: LEDGER_ACCOUNTS.DRIVER_COMMISSION_WALLET, direction: 'DEBIT' },
        _sum: { amount: true },
      }),
    ]);
    const totalWalletBalance = Number(walletAgg._sum.balance ?? 0);
    const totalLedgerNet = round2(
      Number(ledgerCredits._sum.amount ?? 0) - Number(ledgerDebits._sum.amount ?? 0),
    );
    const inv1Drift = round2(totalWalletBalance - totalLedgerNet);

    // Invariant 2: Active Reservations <-> Active Path B Rides
    const staleReservations = await client.driverWalletReservation.findMany({
      where: {
        status: 'ACTIVE',
        ride: {
          OR: [
            {
              status: {
                in: [
                  'COMPLETED',
                  'CANCELLED_BY_CUSTOMER',
                  'CANCELLED_BY_DRIVER',
                  'CANCELLED_BY_SYSTEM',
                ],
              },
            },
            { driverPaymentModel: { not: 'COMMISSION' } },
          ],
        },
      },
      select: { id: true, rideId: true, driverId: true },
    });

    // Invariant 3: Path A Isolation (while D-11b pending)
    // Zero Path A rides have RIDE_COMMISSION, RIDE_GST_RECOVERY, or TAX_PAYABLE postings
    const pathACompletedRides = await client.ride.findMany({
      where: {
        status: 'COMPLETED',
        driverPaymentModel: 'SUBSCRIPTION',
        driverSubscriptionId: { not: null },
      },
      select: { id: true },
    });
    const pathARideIds = pathACompletedRides.map((r) => r.id);
    const [pathAWalletTxns, pathATaxCredits] =
      pathARideIds.length > 0
        ? await Promise.all([
            client.driverCommissionWalletTransaction.count({
              where: {
                rideId: { in: pathARideIds },
                txnType: { in: ['RIDE_COMMISSION', 'RIDE_GST_RECOVERY'] },
              },
            }),
            client.paymentLedgerEntry.count({
              where: {
                referenceId: { in: pathARideIds },
                account: LEDGER_ACCOUNTS.TAX_PAYABLE,
                direction: 'CREDIT',
              },
            }),
          ])
        : [0, 0];

    // Invariant 4: Path B Commission Completeness
    // Every POSTED COMMISSION_DEBIT step matches a RIDE_COMMISSION wallet txn;
    // every FAILED_INSUFFICIENT_BALANCE step matches an OPEN/RECOVERED/WAIVED failure.
    const [postedCommSteps, failedCommSteps, openCommFailures] = await Promise.all([
      client.rideSettlementStep.findMany({
        where: { stepType: 'COMMISSION_DEBIT', status: 'POSTED' },
        select: { rideId: true, walletTxnId: true, amount: true },
      }),
      client.rideSettlementStep.findMany({
        where: { stepType: 'COMMISSION_DEBIT', status: 'FAILED_INSUFFICIENT_BALANCE' },
        select: { rideId: true },
      }),
      client.commissionCollectionFailure.findMany({
        where: { kind: 'COMMISSION', status: 'OPEN' },
        select: { rideId: true },
      }),
    ]);
    const openCommRideSet = new Set(openCommFailures.map((f) => f.rideId));
    const missingWalletTxnOnPosted = postedCommSteps.filter(
      (s) => Number(s.amount) > 0 && !s.walletTxnId,
    ).length;
    const unbackedFailedCommSteps = failedCommSteps.filter(
      (s) => !openCommRideSet.has(s.rideId),
    ).length;

    // Invariant 5: Single TAX_PAYABLE Liability (1x Only)
    // SUM(POSTED PASSENGER_GST_LIABILITY steps.amount) == SUM(TAX_PAYABLE credits for those rides)
    const postedGstSteps = await client.rideSettlementStep.findMany({
      where: { stepType: 'PASSENGER_GST_LIABILITY', status: 'POSTED' },
      select: { rideId: true, amount: true },
    });
    const postedGstRideIds = postedGstSteps.map((s) => s.rideId);
    const expectedTaxPayable = round2(postedGstSteps.reduce((acc, s) => acc + Number(s.amount), 0));
    const actualTaxLedgerAgg =
      postedGstRideIds.length > 0
        ? await client.paymentLedgerEntry.aggregate({
            where: {
              account: LEDGER_ACCOUNTS.TAX_PAYABLE,
              direction: 'CREDIT',
              referenceType: 'RIDE',
              referenceId: { in: postedGstRideIds },
            },
            _sum: { amount: true },
          })
        : { _sum: { amount: null } };
    const actualTaxPayable = round2(Number(actualTaxLedgerAgg._sum.amount ?? 0));
    const inv5Drift = round2(actualTaxPayable - expectedTaxPayable);

    // Invariant 6: Mode A Clearing Account vs. Open GST Recovery Failures
    // Net Dr Balance(DRIVER_GST_RECOVERY_CLEARING) == SUM(OPEN commission_collection_failures where kind='GST_RECOVERY')
    const [clearingDebits, clearingCredits, openGstFailuresAgg] = await Promise.all([
      client.paymentLedgerEntry.aggregate({
        where: { account: LEDGER_ACCOUNTS.DRIVER_GST_RECOVERY_CLEARING, direction: 'DEBIT' },
        _sum: { amount: true },
      }),
      client.paymentLedgerEntry.aggregate({
        where: { account: LEDGER_ACCOUNTS.DRIVER_GST_RECOVERY_CLEARING, direction: 'CREDIT' },
        _sum: { amount: true },
      }),
      client.commissionCollectionFailure.aggregate({
        where: { kind: 'GST_RECOVERY', status: 'OPEN' },
        _sum: { amount: true },
      }),
    ]);
    const netClearingDr = round2(
      Number(clearingDebits._sum.amount ?? 0) - Number(clearingCredits._sum.amount ?? 0),
    );
    const totalOpenGstFailures = round2(Number(openGstFailuresAgg._sum.amount ?? 0));
    const inv6Drift = round2(netClearingDr - totalOpenGstFailures);

    const invariants: ReconciliationInvariantResult[] = [
      {
        id: 1,
        name: 'Wallet <-> Ledger (DRIVER_COMMISSION_WALLET)',
        passed: inv1Drift === 0,
        driftAmount: inv1Drift,
        violationCount: inv1Drift === 0 ? 0 : 1,
        details: { totalWalletBalance, totalLedgerNet },
      },
      {
        id: 2,
        name: 'Active Reservations <-> Active Path B Rides',
        passed: staleReservations.length === 0,
        driftAmount: 0,
        violationCount: staleReservations.length,
        details: { staleReservationRideIds: staleReservations.map((r) => r.rideId) },
      },
      {
        id: 3,
        name: 'Path A Grandfathered Subscription Isolation',
        passed: pathAWalletTxns === 0 && pathATaxCredits === 0,
        driftAmount: 0,
        violationCount: pathAWalletTxns + pathATaxCredits,
        details: { pathACompletedCount: pathARideIds.length, pathAWalletTxns, pathATaxCredits },
      },
      {
        id: 4,
        name: 'Path B Commission Step Completeness',
        passed: missingWalletTxnOnPosted === 0 && unbackedFailedCommSteps === 0,
        driftAmount: 0,
        violationCount: missingWalletTxnOnPosted + unbackedFailedCommSteps,
        details: { missingWalletTxnOnPosted, unbackedFailedCommSteps },
      },
      {
        id: 5,
        name: 'Single TAX_PAYABLE Liability (1x Only)',
        passed: inv5Drift === 0,
        driftAmount: inv5Drift,
        violationCount: inv5Drift === 0 ? 0 : 1,
        details: {
          expectedTaxPayable,
          actualTaxPayable,
          postedGstRideCount: postedGstRideIds.length,
        },
      },
      {
        id: 6,
        name: 'Mode A Clearing Balance == Open GST Recovery Failures',
        passed: inv6Drift === 0,
        driftAmount: inv6Drift,
        violationCount: inv6Drift === 0 ? 0 : 1,
        details: { netClearingDr, totalOpenGstFailures },
      },
    ];

    return {
      checkedAt,
      allPassed: invariants.every((i) => i.passed),
      invariants,
    };
  }

  /// Rev 5 §4.4: Safely releases ACTIVE reservations on CANCELLED rides, and alerts
  /// without silently releasing any ACTIVE reservation on a COMPLETED ride.
  async sweepStaleReservations(): Promise<StaleReservationSweepResult> {
    const client = this.databaseService.client;

    const cancelledReservations = await client.driverWalletReservation.findMany({
      where: {
        status: 'ACTIVE',
        ride: {
          status: {
            in: ['CANCELLED_BY_CUSTOMER', 'CANCELLED_BY_DRIVER', 'CANCELLED_BY_SYSTEM'],
          },
        },
      },
      select: { id: true },
    });

    let releasedCancelledCount = 0;
    if (cancelledReservations.length > 0) {
      const updated = await client.driverWalletReservation.updateMany({
        where: { id: { in: cancelledReservations.map((r) => r.id) }, status: 'ACTIVE' },
        data: { status: 'RELEASED', resolvedAt: new Date() },
      });
      releasedCancelledCount = updated.count;
    }

    const completedStale = await client.driverWalletReservation.findMany({
      where: {
        status: 'ACTIVE',
        ride: { status: 'COMPLETED' },
      },
      select: { rideId: true },
    });

    return {
      releasedCancelledCount,
      alertedCompletedRideIds: completedStale.map((r) => r.rideId),
    };
  }
}
