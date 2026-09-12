import { DriverRepository } from '../../repositories/driver.repository.js';
import { DriverSubscriptionRepository } from '@modules/subscriptions/repositories/driver-subscription.repository.js';
import { DriverNotFoundError } from '../../errors/driver.errors.js';
import type { Driver } from '../../types';

export interface PaymentModelStatus {
  paymentModel: string | null;
  pendingPaymentModel: string | null;
  effectiveAt: Date | null;
}

/// 004-driver-subscription-wallet. plan.md "Driver Payment Model Selection &
/// Switching" — first selection and the SUBSCRIPTION -> COMMISSION switch
/// (the only direction this service ever persists). The opposite direction,
/// COMMISSION -> SUBSCRIPTION, is never staged or written here: per BD-5 it
/// finalises only when a purchased subscription actually activates
/// (`SubscriptionPaymentConsumer`), through the normal `POST
/// /api/v1/subscriptions` flow — there is nothing for this service to persist
/// for that direction ahead of time.
export class PaymentModelService {
  constructor(
    private readonly driverRepository: DriverRepository,
    private readonly driverSubscriptionRepository: DriverSubscriptionRepository,
  ) {}

  async select(
    driverId: string,
    model: 'SUBSCRIPTION' | 'COMMISSION',
  ): Promise<PaymentModelStatus> {
    const driver = await this.driverRepository.findById(driverId);
    if (!driver) throw new DriverNotFoundError(driverId);
    if (!driver.paymentModel) {
      if (model === 'COMMISSION') {
        const updated = await this.driverRepository.updatePaymentModel(driverId, 'COMMISSION');
        return this.toStatus(updated, null);
      }
      // First selection of SUBSCRIPTION is recorded nowhere yet — it only
      // takes effect once the driver purchases a plan and it activates.
      return this.toStatus(driver, null);
    }
    if (driver.paymentModel === model) {
      return this.toStatus(driver, null);
    }
    return this.requestSwitch(driverId, model);
  }

  async requestSwitch(
    driverId: string,
    targetModel: 'SUBSCRIPTION' | 'COMMISSION',
  ): Promise<PaymentModelStatus> {
    const driver = await this.driverRepository.findById(driverId);
    if (!driver) throw new DriverNotFoundError(driverId);
    if (targetModel === 'SUBSCRIPTION') {
      return this.toStatus(driver, null);
    }
    // targetModel === 'COMMISSION', switching away from SUBSCRIPTION.
    const activeSubscription = await this.driverSubscriptionRepository.findActive(driverId);
    if (activeSubscription) {
      // Staged (BD-5): the driver stays SUBSCRIPTION until the paid period
      // they already own runs its course — the expiry sweep applies this.
      await this.driverRepository.setPendingPaymentModel(driverId, 'COMMISSION');
      return this.toStatus(
        { ...driver, pendingPaymentModel: 'COMMISSION' },
        activeSubscription.expiryDate ?? null,
      );
    }
    const updated = await this.driverRepository.updatePaymentModel(driverId, 'COMMISSION');
    return this.toStatus(updated, null);
  }

  async getStatus(driverId: string): Promise<PaymentModelStatus> {
    const driver = await this.driverRepository.findById(driverId);
    if (!driver) throw new DriverNotFoundError(driverId);
    let effectiveAt: Date | null = null;
    if (driver.pendingPaymentModel) {
      const activeSubscription = await this.driverSubscriptionRepository.findActive(driverId);
      effectiveAt = activeSubscription?.expiryDate ?? null;
    }
    return this.toStatus(driver, effectiveAt);
  }

  private toStatus(
    driver: Pick<Driver, 'paymentModel' | 'pendingPaymentModel'>,
    effectiveAt: Date | null,
  ): PaymentModelStatus {
    return {
      paymentModel: driver.paymentModel,
      pendingPaymentModel: driver.pendingPaymentModel,
      effectiveAt,
    };
  }
}
