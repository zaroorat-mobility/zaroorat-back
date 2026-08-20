import { DatabaseService } from '@core/database';
import { RedisService } from '@core/cache/RedisService.js';
import { PaymentMetrics } from '../metrics/payment.metrics.js';
import { logger } from '@shared/logger/index.js';
import { Decimal } from '../types/index.js';
export interface ReconciliationReport {
  scanned: number;
  matched: number;
  mismatched: number;
}
export class ReconciliationJob {
  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly paymentMetrics: PaymentMetrics,
  ) {}
  async run(): Promise<ReconciliationReport> {
    const lockToken = await this.redis.lock.acquire('job:reconciliation', 60000);
    if (!lockToken) {
      logger.info('Reconciliation job lock held by another process');
      return { scanned: 0, matched: 0, mismatched: 0 };
    }
    let scanned = 0;
    let matched = 0;
    let mismatched = 0;
    try {
      const wallets = await this.db.client.customerWallet.findMany({ take: 100 });
      for (const wallet of wallets) {
        scanned++;
        const txSum = await this.db.client.customerWalletTransaction.aggregate({
          where: { walletId: wallet.id },
          _sum: { amount: true },
        });
        const computed = txSum._sum.amount ?? new Decimal(0);
        const stored = wallet.balance;
        const diff = stored.sub(computed);
        const status = diff.isZero() ? 'MATCHED' : 'MISMATCH';
        if (status === 'MISMATCH') {
          mismatched++;
          this.paymentMetrics.reconciliationMismatch({
            walletId: wallet.id,
            difference: diff.toNumber(),
          });
          logger.warn(
            { walletId: wallet.id, stored: stored.toNumber(), computed: computed.toNumber() },
            'Reconciliation mismatch detected',
          );
        } else {
          matched++;
        }
        await this.db.client.walletReconciliation.create({
          data: {
            walletType: 'CUSTOMER',
            walletId: wallet.id,
            asOf: new Date(),
            storedBalance: stored,
            computedBalance: computed,
            difference: diff,
            status,
          },
        });
      }
    } finally {
      await this.redis.lock.release('job:reconciliation', lockToken);
    }
    return { scanned, matched, mismatched };
  }
}
