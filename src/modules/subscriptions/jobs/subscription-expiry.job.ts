import { RedisService } from '@core/cache/RedisService.js';
import { TransactionManager } from '@core/database';
import { logger } from '@shared/logger/index.js';
import { DriverRepository } from '@modules/drivers/repositories/driver.repository.js';
import { StatusService } from '@modules/drivers/services/status/status.service.js';
import { DriverSubscriptionRepository } from '../repositories/driver-subscription.repository.js';

/// decisions.md BD-2/BD-3/BD-5 — the scheduled sweep that expires ACTIVE
/// subscriptions past their `expiryDate` and, for any driver with a staged
/// `SUBSCRIPTION → COMMISSION` switch (BD-5), applies it at exactly this
/// moment: "the current paid period runs its course." Redis lock is a
/// scan-efficiency optimisation only (constitution §5.3) — correctness comes
/// from `expireIfActive`'s conditional claim, matching every other payments
/// job's documented reasoning.
export class SubscriptionExpiryJob {
  constructor(
    private readonly redis: RedisService,
    private readonly driverSubscriptionRepository: DriverSubscriptionRepository,
    private readonly driverRepository: DriverRepository,
    private readonly txManager: TransactionManager,
    private readonly statusService: StatusService,
  ) {}

  async run(now: Date = new Date()): Promise<number> {
    const lockToken = await this.redis.lock.acquire('job:subscription_expiry', 60000);
    if (!lockToken) return 0;
    let expiredCount = 0;
    try {
      const due = await this.driverSubscriptionRepository.findDueForExpiry(now);
      for (const subscription of due) {
        try {
          await this.txManager.execute(async (tx) => {
            const expired = await this.driverSubscriptionRepository.expireIfActive(
              subscription.id,
              tx,
            );
            if (!expired) return; // already handled by a prior/concurrent run
            const driver = await this.driverRepository.findById(subscription.driverId, tx);
            if (driver?.pendingPaymentModel === 'COMMISSION') {
              // BD-5: explicit switch request takes priority over auto-renewal.
              await this.driverRepository.updatePaymentModel(
                subscription.driverId,
                'COMMISSION',
                tx,
              );
            }
          });
          expiredCount++;
        } catch (err) {
          logger.warn(
            { err, subscriptionId: subscription.id },
            '[subscriptions] failed to expire one subscription',
          );
        }
      }
      await this.takeExpiredDriversOffline(now);
    } catch (err) {
      logger.error({ err }, '[subscriptions] error running subscription expiry job');
    } finally {
      await this.redis.lock.release('job:subscription_expiry', lockToken);
    }
    return expiredCount;
  }

  /// An expired plan left the driver ONLINE and in the dispatch index. Swept
  /// from current state rather than from this run's expiries, so a driver whose
  /// plan lapsed mid-ride, or whose earlier attempt failed, is caught on a later
  /// run — and a driver already offline is simply not found again.
  private async takeExpiredDriversOffline(now: Date): Promise<void> {
    const driverIds = await this.driverSubscriptionRepository.findOnShiftWithoutActivePlan(now);
    for (const driverId of driverIds) {
      try {
        await this.statusService.setOffline(driverId, 'SUBSCRIPTION_EXPIRED');
      } catch (err) {
        // DriverOnTripError: a ride was accepted between the read and the lock.
        // It finishes normally; the next run takes the driver offline.
        logger.warn({ err, driverId }, '[subscriptions] could not take a driver offline');
      }
    }
  }
}
