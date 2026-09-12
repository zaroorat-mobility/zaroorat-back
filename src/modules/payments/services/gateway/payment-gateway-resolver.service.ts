import { config } from '@config';
import { assertGatewayImplemented, paymentConfig } from '@config/payment/payment.config.js';
import type { PaymentGatewayName } from '@config/payment/payment.config.js';
import { SystemSettingService } from '@modules/admin/system-settings/services/system-setting.service.js';
import {
  PAYMENT_SETTING_KEYS,
  PAYMENT_SETTINGS_CATEGORY,
} from '@modules/admin/system-settings/integrations/constants/integration-settings.constants.js';
import { RazorpayGatewayProvider } from '../../../../integrations/razorpay/razorpay.client.js';
import { StripeGatewayProvider } from '../../../../integrations/stripe/stripe.client.js';
import { MockGatewayProvider } from './mock.gateway.js';
import type { PaymentGatewayProvider } from './gateway.provider.js';

export class PaymentGatewayNotConfiguredError extends Error {
  constructor(readonly gateway: PaymentGatewayName) {
    super(`Payment gateway "${gateway}" has no credentials configured`);
    this.name = 'PaymentGatewayNotConfiguredError';
  }
}

export class PaymentGatewayDisabledError extends Error {
  constructor(readonly gateway: PaymentGatewayName) {
    super(`Payment gateway "${gateway}" is disabled by admin configuration`);
    this.name = 'PaymentGatewayDisabledError';
  }
}

type SettingsMap = Map<string, { value: string | null; isSecret: boolean; version: number }>;

/// Resolves the ONE admin-configured active gateway, or an existing intent's
/// already-fixed provider — the ONE seam business services (`IntentService`,
/// and through it `SubscriptionService` and `CommissionWalletController`)
/// consult instead of importing Razorpay/Stripe clients directly.
/// `RideCollectionService` is deliberately not one of these: the customer's
/// ride fare is never a gateway transaction.
///
/// There is no per-purpose routing and no per-driver provider selection.
/// Admin configures exactly one active provider; every business service that
/// creates a new payment uses whichever one that is, automatically.
///
/// Deliberately does not cache resolved settings or provider instances: a
/// credential rotation or an active-provider change in Admin must take effect
/// on the very next payment, not after a process restart. Provider
/// construction here is cheap (wrapping already-decrypted strings, no
/// connection setup), so a fresh build per call costs nothing worth caching
/// for.
///
/// `getActiveGateway` is for a NEW PaymentIntent only — its result decides
/// what gets written to `PaymentIntent.gateway`. Every call after that
/// (confirming, reconciling) must use `forProviderName` with the intent's OWN
/// stored `gateway` value, never re-resolve the active provider — switching
/// the active provider must never retroactively move an existing intent to a
/// different one.
export class PaymentGatewayResolverService {
  constructor(private readonly systemSettingService: SystemSettingService) {}

  async getActiveGateway(): Promise<PaymentGatewayProvider> {
    const settings = await this.systemSettingService.getCategorySettings(PAYMENT_SETTINGS_CATEGORY);
    const configured = settings.get(PAYMENT_SETTING_KEYS.ACTIVE_PROVIDER)?.value as
      PaymentGatewayName | null | undefined;
    const name = configured ?? paymentConfig.defaultGateway;
    return this.build(name, settings, { enforceEnabled: true });
  }

  /// For an EXISTING PaymentIntent/PaymentTransaction — resolves by the
  /// provider name already stored on the row, never by the current active
  /// provider.
  async forProviderName(name: string): Promise<PaymentGatewayProvider> {
    const settings = await this.systemSettingService.getCategorySettings(PAYMENT_SETTINGS_CATEGORY);
    return this.build(name as PaymentGatewayName, settings, { enforceEnabled: false });
  }

  /// The secret a provider's OWN webhook route verifies signatures against —
  /// admin-configured value first, then that provider's env var, then the
  /// legacy shared `PAYMENT_WEBHOOK_SECRET`, matching
  /// `payment.config.ts`'s `readProviderWebhookSecret` fallback order exactly
  /// (this is the same lookup, just able to see an admin override the static
  /// config snapshot taken at process start cannot).
  async webhookSecretFor(name: PaymentGatewayName): Promise<string> {
    const settings = await this.systemSettingService.getCategorySettings(PAYMENT_SETTINGS_CATEGORY);
    if (name === 'razorpay') {
      return this.stringSetting(
        settings,
        PAYMENT_SETTING_KEYS.RAZORPAY_WEBHOOK_SECRET,
        paymentConfig.razorpayWebhookSecret,
      );
    }
    if (name === 'stripe') {
      return this.stringSetting(
        settings,
        PAYMENT_SETTING_KEYS.STRIPE_WEBHOOK_SECRET,
        paymentConfig.stripeWebhookSecret,
      );
    }
    return paymentConfig.webhookSecret;
  }

  private async build(
    name: PaymentGatewayName,
    settings: SettingsMap,
    options: { enforceEnabled: boolean },
  ): Promise<PaymentGatewayProvider> {
    // Refuses `mock` outright in production/staging (and, by construction,
    // every gateway here has a real network-calling implementation now — see
    // UNIMPLEMENTED_GATEWAYS in payment.config.ts).
    assertGatewayImplemented(name, config.app.environment);

    if (name === 'mock') return new MockGatewayProvider();

    if (options.enforceEnabled && !this.isEnabled(name, settings)) {
      throw new PaymentGatewayDisabledError(name);
    }

    if (name === 'razorpay') {
      const keyId = this.stringSetting(
        settings,
        PAYMENT_SETTING_KEYS.RAZORPAY_KEY_ID,
        paymentConfig.razorpayKeyId,
      );
      const keySecret = this.stringSetting(
        settings,
        PAYMENT_SETTING_KEYS.RAZORPAY_KEY_SECRET,
        paymentConfig.razorpayKeySecret,
      );
      if (!keyId || !keySecret) throw new PaymentGatewayNotConfiguredError('razorpay');
      const environment = this.environmentSetting(
        settings,
        PAYMENT_SETTING_KEYS.RAZORPAY_ENVIRONMENT,
        paymentConfig.razorpayEnvironment,
      );
      return new RazorpayGatewayProvider(keyId, keySecret, environment);
    }

    if (name === 'stripe') {
      const secretKey = this.stringSetting(
        settings,
        PAYMENT_SETTING_KEYS.STRIPE_SECRET_KEY,
        paymentConfig.stripeSecretKey,
      );
      if (!secretKey) throw new PaymentGatewayNotConfiguredError('stripe');
      return new StripeGatewayProvider(secretKey);
    }

    throw new PaymentGatewayNotConfiguredError(name);
  }

  private isEnabled(name: PaymentGatewayName, settings: SettingsMap): boolean {
    const key =
      name === 'razorpay'
        ? PAYMENT_SETTING_KEYS.RAZORPAY_ENABLED
        : name === 'stripe'
          ? PAYMENT_SETTING_KEYS.STRIPE_ENABLED
          : null;
    if (!key) return true;
    const raw = settings.get(key)?.value;
    // Unset means "not yet explicitly configured" — enabled by default so a
    // fresh deployment whose credentials come entirely from env vars (no
    // admin settings rows written yet) is not silently blocked.
    if (raw == null) return true;
    return raw === 'true';
  }

  private stringSetting(
    settings: SettingsMap,
    key: string,
    envFallback: string | undefined,
  ): string {
    const fromSettings = settings.get(key)?.value;
    if (fromSettings != null && fromSettings.trim() !== '') return fromSettings;
    return envFallback ?? '';
  }

  private environmentSetting(
    settings: SettingsMap,
    key: string,
    envFallback: 'sandbox' | 'live',
  ): 'sandbox' | 'live' {
    const raw = settings.get(key)?.value;
    if (raw === 'live' || raw === 'sandbox') return raw;
    return envFallback;
  }
}
