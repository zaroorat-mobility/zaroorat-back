import { Decimal } from '../../types/index.js';
import type { TransactionClient } from '@core/database/TransactionManager';
import { LedgerRepository, type LedgerItemInput } from '../../repositories/ledger.repository.js';
import type { PaymentLedgerEntry } from '../../types';
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
    data: {
      totalFare: Decimal;
      driverPayable: Decimal;
      platformCommission: Decimal;
      customerUserId: string;
      driverId: string;
      rideId: string;
      paymentMethod: string;
    },
    tx: TransactionClient,
  ): Promise<PaymentLedgerEntry[]> {
    if (data.paymentMethod === 'CASH') {
      if (data.platformCommission.lte(0)) return [];
      return this.postTransactionGroup(
        [
          {
            account: 'DRIVER_PAYABLE',
            accountRefId: data.driverId,
            direction: 'DEBIT',
            amount: data.platformCommission,
            referenceType: 'RIDE',
            referenceId: data.rideId,
            description: `Commission owed on cash ride ${data.rideId}`,
          },
          {
            account: 'PLATFORM_COMMISSION',
            direction: 'CREDIT',
            amount: data.platformCommission,
            referenceType: 'RIDE',
            referenceId: data.rideId,
            description: `Platform commission for cash ride ${data.rideId}`,
          },
        ],
        tx,
      );
    }
    const items: LedgerItemInput[] = [
      {
        account: 'CUSTOMER_WALLET',
        accountRefId: data.customerUserId,
        direction: 'DEBIT',
        amount: data.totalFare,
        referenceType: 'RIDE',
        referenceId: data.rideId,
        description: `Fare payment for ride ${data.rideId}`,
      },
    ];
    if (data.driverPayable.gt(0)) {
      items.push({
        account: 'DRIVER_PAYABLE',
        accountRefId: data.driverId,
        direction: 'CREDIT',
        amount: data.driverPayable,
        referenceType: 'RIDE',
        referenceId: data.rideId,
        description: `Driver earnings for ride ${data.rideId}`,
      });
    }
    if (data.platformCommission.gt(0)) {
      items.push({
        account: 'PLATFORM_COMMISSION',
        direction: 'CREDIT',
        amount: data.platformCommission,
        referenceType: 'RIDE',
        referenceId: data.rideId,
        description: `Platform commission for ride ${data.rideId}`,
      });
    }
    return this.postTransactionGroup(items, tx);
  }
}
