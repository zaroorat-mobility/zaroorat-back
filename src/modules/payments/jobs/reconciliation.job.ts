import { DatabaseService } from '@core/database';
import { RedisService } from '@core/cache/RedisService.js';
import { PaymentMetrics } from '../metrics/payment.metrics.js';
import { EventPublisher } from '@core/events';
import { paymentEvent, PAYMENT_EVENT_CATALOG } from '../events/catalog.js';
import { logger } from '@shared/logger/index.js';
import { paymentConfig } from '@config';
import { Decimal } from '../types/index.js';
export interface ReconciliationReport {
  scanned: number;
  matched: number;
  mismatched: number;
  /// Divergence in entries older than `PAYMENT_LEDGER_CUTOVER_AT`. Reported
  /// separately and never mixed into `mismatched`, so a known-bad history
  /// cannot keep the live alarm permanently red — and is never suppressed
  /// either, because BD-7 makes it uncorrectable, not invisible.
  historicalMismatched: number;
}
export class ReconciliationJob {
  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly paymentMetrics: PaymentMetrics,
    private readonly eventPublisher: EventPublisher,
  ) {}
  async run(): Promise<ReconciliationReport> {
    const lockToken = await this.redis.lock.acquire('job:reconciliation', 60000);
    if (!lockToken) {
      logger.info('Reconciliation job lock held by another process');
      return { scanned: 0, matched: 0, mismatched: 0, historicalMismatched: 0 };
    }
    let scanned = 0;
    let matched = 0;
    let mismatched = 0;
    let historicalMismatched = 0;
    const cutover = paymentConfig.ledgerCutoverAt;
    try {
      const wallets = await this.db.client.customerWallet.findMany({ take: 100 });
      for (const wallet of wallets) {
        scanned++;
        // Two independent signals, deliberately kept apart.
        //
        // The transaction sum catches a balance that drifted from its own
        // history. The ledger position catches a balance that moved without
        // the double-entry books agreeing — the failure the wallet funding
        // hole actually produced, which summing the wallet's own rows could
        // never have detected because those rows were written too.
        const txSum = await this.db.client.customerWalletTransaction.aggregate({
          where: { walletId: wallet.id },
          _sum: { amount: true },
        });
        const computed = txSum._sum.amount ?? new Decimal(0);
        const ledger = await this.ledgerPosition('CUSTOMER_WALLET', wallet.userId, cutover);
        const stored = wallet.balance;
        const diff = stored.sub(computed);
        // A balance can only be checked against the ledger when the whole
        // wallet postdates the cut-over. If some of its entries are older, the
        // post-cut-over position is a partial sum and comparing an absolute
        // balance to it would report a mismatch on every wallet that existed
        // before the boundary. Those are counted as historical instead — BD-7
        // makes them uncorrectable, not unreportable — and the transaction-sum
        // arm still covers them.
        const comparable = ledger.historical.isZero();
        const ledgerDiff = comparable ? stored.sub(ledger.live) : new Decimal(0);
        if (!comparable) historicalMismatched++;
        const status = diff.isZero() && ledgerDiff.isZero() ? 'MATCHED' : 'MISMATCH';
        if (status === 'MISMATCH') {
          mismatched++;
          this.paymentMetrics.reconciliationMismatch({
            walletId: wallet.id,
            difference: diff.isZero() ? ledgerDiff.toNumber() : diff.toNumber(),
          });
          logger.warn(
            {
              walletId: wallet.id,
              stored: stored.toNumber(),
              computed: computed.toNumber(),
              ledger: ledger.live.toNumber(),
            },
            'Reconciliation mismatch detected',
          );
          // A metric moves a dashboard and a log line waits to be read; neither
          // reaches anything that can act. The catalog has declared this event
          // since the module was written and nothing ever emitted it, so a
          // divergence between a balance and the ledger — the one thing this
          // job exists to find — notified no one.
          await this.publishMismatch(wallet.id, 'CUSTOMER', stored, computed, ledger.live);
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

      // Driver wallets were never reconciled at all. They hold real money and
      // move on the same ledger, so leaving them out meant half the balances
      // on the platform had no check.
      const driverWallets = await this.db.client.driverWallet.findMany({ take: 100 });
      for (const wallet of driverWallets) {
        scanned++;
        const txSum = await this.db.client.driverWalletTransaction.aggregate({
          where: { walletId: wallet.id },
          _sum: { amount: true },
        });
        const computed = txSum._sum.amount ?? new Decimal(0);
        const diff = wallet.balance.sub(computed);
        const status = diff.isZero() ? 'MATCHED' : 'MISMATCH';
        if (status === 'MISMATCH') {
          mismatched++;
          this.paymentMetrics.reconciliationMismatch({
            walletId: wallet.id,
            difference: diff.toNumber(),
          });
          logger.warn(
            {
              walletId: wallet.id,
              driverId: wallet.driverId,
              stored: wallet.balance.toNumber(),
              computed: computed.toNumber(),
            },
            'Driver wallet reconciliation mismatch detected',
          );
          await this.publishMismatch(wallet.id, 'DRIVER', wallet.balance, computed, computed);
        } else {
          matched++;
        }
        await this.db.client.walletReconciliation.create({
          data: {
            walletType: 'DRIVER',
            walletId: wallet.id,
            asOf: new Date(),
            storedBalance: wallet.balance,
            computedBalance: computed,
            difference: diff,
            status,
          },
        });
      }
    } finally {
      await this.redis.lock.release('job:reconciliation', lockToken);
    }
    return { scanned, matched, mismatched, historicalMismatched };
  }

  /// Net position of a ledger account, split at the BD-7 cut-over.
  ///
  /// `live` is what the running platform is accountable for. `historical` is
  /// what predates the boundary: reported, never rewritten. BD-7 approved
  /// prospective-only correction, so a bad entry from before the cut-over
  /// stays exactly as it was written.
  private async ledgerPosition(
    account: string,
    accountRefId: string,
    cutover: Date,
  ): Promise<{ live: Decimal; historical: Decimal }> {
    const entries = await this.db.client.paymentLedgerEntry.findMany({
      where: { account, accountRefId },
      select: { direction: true, amount: true, createdAt: true },
    });
    let live = new Decimal(0);
    let historical = new Decimal(0);
    for (const entry of entries) {
      const signed = entry.direction === 'CREDIT' ? entry.amount : entry.amount.neg();
      if (entry.createdAt >= cutover) live = live.add(signed);
      else historical = historical.add(signed);
    }
    return { live, historical };
  }

  /// Published without a transaction on purpose: the job writes one
  /// `wallet_reconciliations` row per wallet outside any transaction, so there
  /// is none to join. A mismatch that is recorded but not announced is the
  /// failure mode this closes, and an outbox row is the only delivery here
  /// that survives the process dying mid-scan.
  private async publishMismatch(
    walletId: string,
    walletType: 'CUSTOMER' | 'DRIVER',
    stored: Decimal,
    computed: Decimal,
    ledger: Decimal,
  ): Promise<void> {
    await this.eventPublisher.publish(
      paymentEvent(PAYMENT_EVENT_CATALOG.RECONCILIATION_MISMATCH, walletId, {
        walletId,
        walletType,
        stored: stored.toNumber(),
        computed: computed.toNumber(),
        ledger: ledger.toNumber(),
      }),
    );
  }
}
