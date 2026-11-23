import { EventBus, type EventEnvelope, type Unsubscribe } from '@core/events';
import { logger } from '@shared/logger/index.js';
import { RIDE_EVENT_CATALOG } from '@modules/rides/events/catalog.js';
import { PAYMENT_EVENT_CATALOG } from '@modules/payments/events/catalog.js';
import { FiscalDocumentService } from '../services/fiscal-document.service.js';

/// Phase 6 (M-09) outbox consumer: issues immutable gapless fiscal documents on `ride.completed`
/// and Commission Wallet Recharge Receipts on `driver.commission_wallet.credited`.
/// Strictly gated behind `documents.issue` (default OFF) and idempotent under at-least-once delivery.
export class FiscalDocumentRideCompletedConsumer {
  constructor(
    private readonly eventBus: EventBus,
    private readonly fiscalDocumentService: FiscalDocumentService,
  ) {}

  register(): Unsubscribe {
    const unsubRide = this.eventBus.on(RIDE_EVENT_CATALOG.COMPLETED, (e) =>
      this.onRideCompleted(e),
    );
    const unsubRecharge = this.eventBus.on(
      PAYMENT_EVENT_CATALOG.DRIVER_COMMISSION_WALLET_CREDITED,
      (e) => this.onWalletCredited(e),
    );
    return () => {
      unsubRide();
      unsubRecharge();
    };
  }

  private async onRideCompleted(envelope: EventEnvelope): Promise<void> {
    const { rideId } = envelope.data as { rideId?: string };
    if (!rideId) return;
    try {
      await this.fiscalDocumentService.issueForCompletedRide(rideId);
    } catch (err) {
      logger.error({ err, rideId }, '[fiscal-document] ride.completed issuance failed');
    }
  }

  private async onWalletCredited(envelope: EventEnvelope): Promise<void> {
    const data = envelope.data as {
      driverId?: string;
      walletId?: string;
      amount?: number;
      newBalance?: number;
    };
    if (!data.driverId || !data.walletId || typeof data.amount !== 'number' || data.amount <= 0) {
      return;
    }
    try {
      await this.fiscalDocumentService.issueForWalletRecharge({
        driverId: data.driverId,
        walletId: data.walletId,
        amount: data.amount,
        newBalance: typeof data.newBalance === 'number' ? data.newBalance : data.amount,
        eventId: envelope.eventId,
      });
    } catch (err) {
      logger.error(
        { err, driverId: data.driverId },
        '[fiscal-document] wallet recharge receipt issuance failed',
      );
    }
  }
}
