import { Decimal } from '../../types/index.js';
import type { TransactionClient } from '@core/database/TransactionManager';
import { LedgerRepository, type LedgerItemInput } from '../../repositories/ledger.repository.js';
import type { PaymentLedgerEntry } from '../../types';
/// FR-006. The four places a completed ride's money ends up.
///
/// Before Phase 2 there were two — the driver and the platform's commission —
/// because commission was levied on `totalFare` and so silently swallowed the
/// tax and the platform fee. Now that the driver is paid out of ride revenue
/// alone, tax and the platform fee are distinct amounts with nowhere to go, and
/// `postGroup` rightly refuses a group that does not balance.
export interface RideFareSplit {
  totalFare: Decimal;
  driverEarning: Decimal;
  platformCommission: Decimal;
  taxAmount: Decimal;
  platformFee: Decimal;
}

/// One leg, with its direction chosen by the sign of the amount.
///
/// `platformCommission` is a residual and goes negative when a promotion costs
/// more than the platform's margin on that ride (BD-2: the platform bears the
/// discount). A negative credit is not a thing, so it becomes a debit of the
/// same magnitude — which is the honest entry: on that ride the platform paid
/// out more than it took in.
function signedLeg(
  item: Omit<LedgerItemInput, 'direction' | 'amount'>,
  amount: Decimal,
  whenPositive: 'DEBIT' | 'CREDIT',
): LedgerItemInput[] {
  if (amount.isZero()) return [];
  const flipped = whenPositive === 'CREDIT' ? 'DEBIT' : 'CREDIT';
  return [
    {
      ...item,
      direction: amount.gt(0) ? whenPositive : flipped,
      amount: amount.abs(),
    },
  ];
}

/// Where the fare goes, once it has been funded. Sums to `totalFare` by FR-006.
function fareDestinationLegs(
  fare: RideFareSplit,
  driverId: string,
  rideId: string,
  suffix = '',
): LedgerItemInput[] {
  return [
    ...signedLeg(
      {
        account: 'DRIVER_PAYABLE',
        accountRefId: driverId,
        referenceType: 'RIDE',
        referenceId: rideId,
        description: `Driver earnings for ride ${rideId}${suffix}`,
      },
      fare.driverEarning,
      'CREDIT',
    ),
    ...signedLeg(
      {
        account: 'TAX_PAYABLE',
        referenceType: 'RIDE',
        referenceId: rideId,
        description: `Tax collected on ride ${rideId}${suffix}`,
      },
      fare.taxAmount,
      'CREDIT',
    ),
    ...signedLeg(
      {
        account: 'PLATFORM_FEE',
        referenceType: 'RIDE',
        referenceId: rideId,
        description: `Platform fee on ride ${rideId}${suffix}`,
      },
      fare.platformFee,
      'CREDIT',
    ),
    ...signedLeg(
      {
        account: 'PLATFORM_COMMISSION',
        referenceType: 'RIDE',
        referenceId: rideId,
        description: `Platform commission for ride ${rideId}${suffix}`,
      },
      fare.platformCommission,
      'CREDIT',
    ),
  ];
}

export { fareDestinationLegs, signedLeg };

export class LedgerService {
  constructor(private readonly ledgerRepo: LedgerRepository) {}
  async postTransactionGroup(
    items: LedgerItemInput[],
    tx: TransactionClient,
    customGroupUuid?: string,
  ): Promise<PaymentLedgerEntry[]> {
    for (const item of items) {
      if (item.amount.lte(0)) {
        throw new Error(`Ledger entry amount must be strictly positive: ${item.amount}`);
      }
    }
    return this.ledgerRepo.postGroup(items, tx, customGroupUuid);
  }
  async recordTripPayment(
    data: RideFareSplit & {
      driverPayable: Decimal;
      customerUserId: string;
      driverId: string;
      rideId: string;
      paymentMethod: string;
      /// 004-driver-subscription-wallet. The payment model pinned on the ride
      /// at acceptance (`Ride.driverPaymentModel`, FR-031). Whenever a model
      /// is set, driver commission is owned entirely by that model's own
      /// mechanism — the Commission Wallet deduction for COMMISSION, the
      /// subscription fee for SUBSCRIPTION — and this posting must never
      /// recognise it a second time: tax and the platform fee are still owed
      /// here, commission never is. `null` is a ride written before the
      /// column existed, which keeps the original, single, unsplit
      /// commission-on-customer-payment behaviour.
      driverPaymentModel?: string | null;
    },
    tx: TransactionClient,
  ): Promise<PaymentLedgerEntry[]> {
    const commissionOwnedElsewhere = data.driverPaymentModel != null;
    /// Redistributed, not discarded: `fareDestinationLegs` must still sum to
    /// `totalFare` (FR-006) whichever way the commission component is
    /// routed, or the group no longer balances. The driver already paid this
    /// ride's commission through their payment model's own mechanism, so the
    /// portion of the customer's fare that would otherwise have gone to
    /// PLATFORM_COMMISSION becomes additional driver earning instead — the
    /// driver, not the platform, is the party left to receive money the
    /// platform is not taking a second time.
    const creditFare = commissionOwnedElsewhere
      ? {
          ...data,
          driverEarning: data.driverEarning.add(data.platformCommission),
          platformCommission: new Decimal(0),
        }
      : data;
    if (data.paymentMethod !== 'WALLET') {
      /// The customer never pays the platform for a ride fare — CASH, CARD and
      /// UPI all mean the driver collected the whole fare directly (cash in
      /// hand, or a UPI/phone/GPay transfer straight to the driver's own
      /// account), so what the driver owes back is everything that is not
      /// theirs: tax, the platform fee and — for a ride with no payment model
      /// — the commission. It used to be the commission alone, which
      /// understated the debt by exactly the tax and the fee — amounts the
      /// driver was holding. `creditFare.driverEarning` already carries the
      /// redistributed commission when it applies, so subtracting it here is
      /// the same reduction as before, derived once.
      const owedByDriver = data.totalFare.minus(creditFare.driverEarning);
      const legs = [
        ...signedLeg(
          {
            account: 'DRIVER_PAYABLE',
            accountRefId: data.driverId,
            referenceType: 'RIDE',
            referenceId: data.rideId,
            description: `Platform share owed on ride ${data.rideId}`,
          },
          owedByDriver,
          'DEBIT',
        ),
        ...fareDestinationLegs(
          creditFare,
          data.driverId,
          data.rideId,
          ' (driver-collected)',
        ).filter((leg) => leg.account !== 'DRIVER_PAYABLE'),
      ];
      if (legs.length === 0) return [];
      return this.postTransactionGroup(legs, tx);
    }
    // WALLET is the only method left here — the one case where the fare
    // actually lands in a platform-held account, the rider's own wallet
    // balance, rather than going straight to the driver.
    /// `signedLeg` rather than a bare item because `totalFare` can now be zero.
    /// FR-008 moved the minimum-fare floor ahead of the discount, so a promotion
    /// that covers the whole fare leaves the customer paying nothing — while the
    /// driver is still owed their earning, funded entirely by the platform
    /// (BD-2 A). A zero-amount leg is rejected by `postTransactionGroup`, so
    /// writing one unconditionally made a fully discounted ride fail to settle.
    const items: LedgerItemInput[] = [
      ...signedLeg(
        {
          account: 'CUSTOMER_WALLET',
          accountRefId: data.customerUserId,
          referenceType: 'RIDE',
          referenceId: data.rideId,
          description: `Fare payment for ride ${data.rideId}`,
        },
        data.totalFare,
        'DEBIT',
      ),
      ...fareDestinationLegs(creditFare, data.driverId, data.rideId),
    ];
    if (items.length === 0) return [];
    return this.postTransactionGroup(items, tx);
  }
}
