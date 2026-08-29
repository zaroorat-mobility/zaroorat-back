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
    },
    tx: TransactionClient,
  ): Promise<PaymentLedgerEntry[]> {
    if (data.paymentMethod === 'CASH') {
      /// The driver collected the whole fare in cash, so what they owe back is
      /// everything that is not theirs: tax, the platform fee and the
      /// commission. It used to be the commission alone, which understated the
      /// debt by exactly the tax and the fee — amounts the driver was holding.
      const owedByDriver = data.totalFare.minus(data.driverEarning);
      const legs = [
        ...signedLeg(
          {
            account: 'DRIVER_PAYABLE',
            accountRefId: data.driverId,
            referenceType: 'RIDE',
            referenceId: data.rideId,
            description: `Platform share owed on cash ride ${data.rideId}`,
          },
          owedByDriver,
          'DEBIT',
        ),
        ...fareDestinationLegs(data, data.driverId, data.rideId, ' (cash)').filter(
          (leg) => leg.account !== 'DRIVER_PAYABLE',
        ),
      ];
      if (legs.length === 0) return [];
      return this.postTransactionGroup(legs, tx);
    }
    // Where the fare actually came from. A card or UPI charge lands in the
    // gateway's clearing account and never touches the rider's wallet balance;
    // posting it to `CUSTOMER_WALLET` credited a wallet position for money
    // that was never in the wallet, so the balance and the books disagreed by
    // the fare of every card ride (FR-037).
    const fundedFromWallet = data.paymentMethod === 'WALLET';
    const items: LedgerItemInput[] = [
      {
        account: fundedFromWallet ? 'CUSTOMER_WALLET' : 'GATEWAY_CLEARING',
        // Only the wallet account is per-rider; `GATEWAY_CLEARING` is a single
        // platform account, so tagging it with a user would fragment it.
        ...(fundedFromWallet ? { accountRefId: data.customerUserId } : {}),
        direction: 'DEBIT',
        amount: data.totalFare,
        referenceType: 'RIDE',
        referenceId: data.rideId,
        description: `Fare payment for ride ${data.rideId}`,
      },
      ...fareDestinationLegs(data, data.driverId, data.rideId),
    ];
    return this.postTransactionGroup(items, tx);
  }
}
