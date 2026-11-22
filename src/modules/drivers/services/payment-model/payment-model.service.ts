import { DriverRepository } from '../../repositories/driver.repository.js';
import { DriverSubscriptionRepository } from '@modules/subscriptions/repositories/driver-subscription.repository.js';
import {
  CommissionService,
  GstRecoveryService,
  REV5_PRICING_FLAGS,
  type FeatureFlagReader,
} from '@modules/pricing';
import {
  DriverNotFoundError,
  SubscriptionModelDisabledError,
} from '../../errors/driver.errors.js';
import type { Driver } from '../../types';

export interface PaymentModelStatus {
  paymentModel: string | null;
  pendingPaymentModel: string | null;
  effectiveAt: Date | null;
}

export interface DriverCommissionTerms {
  paymentModel: string | null;
  grandfathered: boolean;
  expiresAt: string | null;
  autoRenew: boolean;
  subscriptionModelEnabled: boolean;
  commissionRatePct: number | null;
  gstRecoveryRatePct: number | null;
  combinedDeductionPct: number | null;
  commissionDeductionActive: boolean;
  gstRecoveryActive: boolean;
}

export class PaymentModelService {
  constructor(
    private readonly driverRepository: DriverRepository,
    private readonly driverSubscriptionRepository: DriverSubscriptionRepository,
    private readonly featureFlagService?: FeatureFlagReader,
    private readonly commissionService?: CommissionService,
    private readonly gstRecoveryService?: GstRecoveryService,
  ) {}

  private async isSubscriptionModelEnabled(): Promise<boolean> {
    if (!this.featureFlagService) return false;
    return this.featureFlagService.isEnabledReadOnly(
      REV5_PRICING_FLAGS.SUBSCRIPTION_MODEL_ENABLED,
    );
  }

  async select(
    driverId: string,
    model: 'SUBSCRIPTION' | 'COMMISSION',
  ): Promise<PaymentModelStatus> {
    const driver = await this.driverRepository.findById(driverId);
    if (!driver) throw new DriverNotFoundError(driverId);

    // Rev 5 R2-7 / §1.5: Block new subscription onboarding/switching while flag is OFF.
    if (model === 'SUBSCRIPTION' && !(await this.isSubscriptionModelEnabled())) {
      throw new SubscriptionModelDisabledError();
    }

    if (!driver.paymentModel) {
      if (model === 'COMMISSION') {
        const updated = await this.driverRepository.updatePaymentModel(driverId, 'COMMISSION');
        return this.toStatus(updated, null);
      }
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
      if (!(await this.isSubscriptionModelEnabled())) {
        throw new SubscriptionModelDisabledError();
      }
      return this.toStatus(driver, null);
    }
    const activeSubscription = await this.driverSubscriptionRepository.findActive(driverId);
    if (activeSubscription) {
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

  /// Rev 5 §3.4: Returns dynamic active commission/recovery rates for Path B,
  /// or grandfathered subscription expiry notice for Path A — zero hardcoded percentages.
  async getCommissionTerms(
    driverId: string,
    ctx?: { cityCode?: string | null; vehicleTypeId?: string | null },
  ): Promise<DriverCommissionTerms> {
    const driver = await this.driverRepository.findById(driverId);
    if (!driver) throw new DriverNotFoundError(driverId);

    const subscriptionModelEnabled = await this.isSubscriptionModelEnabled();

    if (driver.paymentModel === 'SUBSCRIPTION') {
      const activeSub = await this.driverSubscriptionRepository.findActive(driverId);
      if (activeSub && activeSub.expiryDate && activeSub.expiryDate > new Date()) {
        return {
          paymentModel: 'SUBSCRIPTION',
          grandfathered: true,
          expiresAt: activeSub.expiryDate.toISOString(),
          autoRenew: false,
          subscriptionModelEnabled,
          commissionRatePct: null,
          gstRecoveryRatePct: null,
          combinedDeductionPct: null,
          commissionDeductionActive: false,
          gstRecoveryActive: false,
        };
      }
    }

    let commissionRatePct: number | null = null;
    let gstRecoveryRatePct: number | null = null;
    let commissionDeductionActive = false;
    let gstRecoveryActive = false;

    if (this.commissionService) {
      commissionDeductionActive = await this.commissionService.isWalletDeductionEnabled();
      try {
        const cfg = await this.commissionService.resolve({
          cityCode: ctx?.cityCode ?? null,
          vehicleTypeId: ctx?.vehicleTypeId ?? null,
        });
        commissionRatePct = cfg.isEnabled ? cfg.commissionRatePct : 0;
      } catch {
        commissionRatePct = null;
      }
    }

    if (this.gstRecoveryService) {
      gstRecoveryActive = await this.gstRecoveryService.isGstRecoveryEnabled();
      try {
        const cfg = await this.gstRecoveryService.resolve({
          cityCode: ctx?.cityCode ?? null,
          vehicleTypeId: ctx?.vehicleTypeId ?? null,
        });
        gstRecoveryRatePct = cfg.isEnabled ? cfg.recoveryRatePct : 0;
      } catch {
        gstRecoveryRatePct = null;
      }
    }

    const combinedDeductionPct =
      commissionRatePct !== null || gstRecoveryRatePct !== null
        ? Math.round(((commissionRatePct ?? 0) + (gstRecoveryRatePct ?? 0)) * 100) / 100
        : null;

    return {
      paymentModel: driver.paymentModel,
      grandfathered: false,
      expiresAt: null,
      autoRenew: false,
      subscriptionModelEnabled,
      commissionRatePct,
      gstRecoveryRatePct,
      combinedDeductionPct,
      commissionDeductionActive,
      gstRecoveryActive,
    };
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
