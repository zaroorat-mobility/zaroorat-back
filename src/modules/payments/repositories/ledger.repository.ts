import { randomUUID } from 'node:crypto';
import { Decimal } from '../types/index.js';
import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import { LedgerImbalanceError } from '../errors/payment.errors.js';
import type { PaymentLedgerEntry } from '../types';

export interface LedgerItemInput {
  account: string;
  accountRefId?: string | null;
  direction: 'DEBIT' | 'CREDIT';
  amount: Decimal;
  referenceType?: string | null;
  referenceId?: string | null;
  description?: string | null;
}

export class LedgerRepository {
  constructor(private readonly db: DatabaseService) {}

  async postGroup(
    items: LedgerItemInput[],
    tx: TransactionClient,
    customGroupUuid?: string,
  ): Promise<PaymentLedgerEntry[]> {
    let debitSum = new Decimal(0);
    let creditSum = new Decimal(0);

    for (const item of items) {
      if (item.direction === 'DEBIT') {
        debitSum = debitSum.add(item.amount);
      } else {
        creditSum = creditSum.add(item.amount);
      }
    }

    if (!debitSum.equals(creditSum)) {
      throw new LedgerImbalanceError(debitSum.toNumber(), creditSum.toNumber());
    }

    const groupUuid = customGroupUuid ?? randomUUID();
    const created: PaymentLedgerEntry[] = [];

    for (const item of items) {
      const entry = await tx.paymentLedgerEntry.create({
        data: {
          entryGroup: groupUuid,
          account: item.account,
          accountRefId: item.accountRefId ?? null,
          direction: item.direction,
          amount: item.amount,
          currency: 'INR',
          referenceType: item.referenceType ?? null,
          referenceId: item.referenceId ?? null,
          description: item.description ?? null,
        },
      });
      created.push(entry);
    }

    return created;
  }

  async findByGroup(entryGroup: string, tx?: TransactionClient): Promise<PaymentLedgerEntry[]> {
    const client = tx ?? this.db.client;
    return client.paymentLedgerEntry.findMany({
      where: { entryGroup },
      orderBy: { createdAt: 'asc' },
    });
  }
}
