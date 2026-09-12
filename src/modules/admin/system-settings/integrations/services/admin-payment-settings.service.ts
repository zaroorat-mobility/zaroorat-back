import type { TransactionManager } from '@core/database';
import { getPaymentConfig } from '@config/payment/payment.config.js';
import { Decimal } from '../../../../payments/types/index.js';
import { maskSecret } from '@shared/crypto/encryption.util.js';
import { SystemSettingService } from '../../services/system-setting.service.js';
import { SystemSettingsCache } from '../../cache/system-settings.cache.js';
import { PaymentGatewayResolverService } from '../../../../payments/services/gateway/payment-gateway-resolver.service.js';
import {
  PAYMENT_SETTING_KEYS,
  PAYMENT_SETTINGS_CATEGORY,
} from '../constants/integration-settings.constants.js';
import {
  isMaskedSecret,
  maxSettingVersion,
  saveIntegrationSettings,
} from '../utils/integration-settings.util.js';
import type { IntegrationHealthService } from './integration-health.service.js';
import type {
  IntegrationHealthSnapshot,
  IntegrationTestResult,
  PaymentEnvironment,
  PaymentGatewayName,
  PaymentSettingsView,
  UpdatePaymentSettingsBody,
} from '../types/integration-settings.types.js';

const PROVIDER_NAMES: readonly Exclude<PaymentGatewayName, 'mock'>[] = ['razorpay', 'stripe'];

function isRealValue(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== '' && !isMaskedSecret(value);
}

function isTestEnvironment(): boolean {
  return (
    process.env.NODE_ENV === 'test' ||
    process.env.APP_ENV === 'test' ||
    Boolean(process.env.VITEST) ||
    Boolean(process.env.JEST_WORKER_ID)
  );
}

export interface PaymentIntegrationTestInput {
  provider?: PaymentGatewayName;
}

export class AdminPaymentSettingsService {
  constructor(
    private readonly systemSettingService: SystemSettingService,
    private readonly systemSettingsCache: SystemSettingsCache,
    private readonly integrationHealthService: IntegrationHealthService,
    private readonly gatewayResolver: PaymentGatewayResolverService,
    private readonly txManager: TransactionManager,
  ) {}

  async getPaymentSettings(): Promise<PaymentSettingsView> {
    const settings = await this.systemSettingService.getCategorySettings(PAYMENT_SETTINGS_CATEGORY);
    const env = getPaymentConfig();

    const readString = (key: string, envFallback: string | undefined): string =>
      settings.get(key)?.value ?? envFallback ?? '';
    const readBool = (key: string, defaultValue: boolean): boolean => {
      const raw = settings.get(key)?.value;
      return raw == null ? defaultValue : raw === 'true';
    };
    const readEnvironment = (key: string, fallback: PaymentEnvironment): PaymentEnvironment => {
      const raw = settings.get(key)?.value;
      return raw === 'live' || raw === 'sandbox' ? raw : fallback;
    };
    const activeProvider = (settings.get(PAYMENT_SETTING_KEYS.ACTIVE_PROVIDER)?.value ??
      env.defaultGateway) as PaymentGatewayName;

    const razorpayKeyId = readString(PAYMENT_SETTING_KEYS.RAZORPAY_KEY_ID, env.razorpayKeyId);
    const razorpayKeySecret = readString(
      PAYMENT_SETTING_KEYS.RAZORPAY_KEY_SECRET,
      env.razorpayKeySecret,
    );
    const razorpayWebhookSecret = readString(
      PAYMENT_SETTING_KEYS.RAZORPAY_WEBHOOK_SECRET,
      env.razorpayWebhookSecret,
    );

    const stripeSecretKey = readString(PAYMENT_SETTING_KEYS.STRIPE_SECRET_KEY, env.stripeSecretKey);
    const stripeWebhookSecret = readString(
      PAYMENT_SETTING_KEYS.STRIPE_WEBHOOK_SECRET,
      env.stripeWebhookSecret,
    );

    return {
      defaultCurrency: readString(PAYMENT_SETTING_KEYS.DEFAULT_CURRENCY, env.defaultCurrency),
      version: maxSettingVersion(settings),
      activeProvider,
      providers: {
        razorpay: {
          enabled: readBool(PAYMENT_SETTING_KEYS.RAZORPAY_ENABLED, true),
          environment: readEnvironment(
            PAYMENT_SETTING_KEYS.RAZORPAY_ENVIRONMENT,
            env.razorpayEnvironment,
          ),
          configured: Boolean(razorpayKeyId && razorpayKeySecret),
          webhookConfigured: Boolean(razorpayWebhookSecret),
          keyId: maskSecret(razorpayKeyId),
          keySecret: maskSecret(razorpayKeySecret),
          webhookSecret: maskSecret(razorpayWebhookSecret),
        },
        stripe: {
          enabled: readBool(PAYMENT_SETTING_KEYS.STRIPE_ENABLED, true),
          environment: readEnvironment(
            PAYMENT_SETTING_KEYS.STRIPE_ENVIRONMENT,
            env.stripeEnvironment,
          ),
          configured: Boolean(stripeSecretKey),
          webhookConfigured: Boolean(stripeWebhookSecret),
          secretKey: maskSecret(stripeSecretKey),
          webhookSecret: maskSecret(stripeWebhookSecret),
        },
      },
    };
  }

  async updatePaymentSettings(
    input: UpdatePaymentSettingsBody,
    actorId?: string,
  ): Promise<PaymentSettingsView> {
    const before = await this.getPaymentSettings();
    const entries: {
      key: string;
      value: string | undefined;
      isSecret?: boolean;
      expectedVersion?: number;
    }[] = [];
    const secret = (key: string, value: string | undefined): void => {
      if (value !== undefined && !isMaskedSecret(value)) {
        entries.push({
          key,
          value,
          isSecret: true,
          ...(input.expectedVersion !== undefined
            ? { expectedVersion: input.expectedVersion }
            : {}),
        });
      }
    };
    const plain = (key: string, value: string | undefined): void => {
      if (value !== undefined) entries.push({ key, value });
    };

    if (input.defaultCurrency !== undefined) {
      plain(PAYMENT_SETTING_KEYS.DEFAULT_CURRENCY, input.defaultCurrency);
    }

    const p = input.providers;

    // Activation is validated against what this request leaves configured —
    // either already configured before this call, or configured by the
    // credential fields this same request is setting — never against a
    // provider that has no real credentials at all. A single scalar setting
    // (not a set/map) is what makes "activate both at once" structurally
    // impossible: there is only ever one value to write.
    if (input.activeProvider !== undefined && input.activeProvider !== 'mock') {
      const target = input.activeProvider;
      const alreadyConfigured = before.providers[target].configured;
      const configuredByThisRequest =
        target === 'razorpay'
          ? isRealValue(p?.razorpay?.keyId) && isRealValue(p?.razorpay?.keySecret)
          : isRealValue(p?.stripe?.secretKey);
      if (!alreadyConfigured && !configuredByThisRequest) {
        throw new Error(
          `Cannot activate ${target}: it has no credentials configured. Configure its ` +
            `${target === 'razorpay' ? 'Key ID and Key Secret' : 'Secret Key'} first, or include ` +
            'them in this same request.',
        );
      }
      plain(PAYMENT_SETTING_KEYS.ACTIVE_PROVIDER, target);
    } else if (input.activeProvider === 'mock') {
      plain(PAYMENT_SETTING_KEYS.ACTIVE_PROVIDER, 'mock');
    }

    if (p?.razorpay) {
      if (p.razorpay.enabled !== undefined) {
        plain(PAYMENT_SETTING_KEYS.RAZORPAY_ENABLED, String(p.razorpay.enabled));
      }
      if (p.razorpay.environment !== undefined) {
        plain(PAYMENT_SETTING_KEYS.RAZORPAY_ENVIRONMENT, p.razorpay.environment);
      }
      secret(PAYMENT_SETTING_KEYS.RAZORPAY_KEY_ID, p.razorpay.keyId);
      secret(PAYMENT_SETTING_KEYS.RAZORPAY_KEY_SECRET, p.razorpay.keySecret);
      secret(PAYMENT_SETTING_KEYS.RAZORPAY_WEBHOOK_SECRET, p.razorpay.webhookSecret);
    }
    if (p?.stripe) {
      if (p.stripe.enabled !== undefined) {
        plain(PAYMENT_SETTING_KEYS.STRIPE_ENABLED, String(p.stripe.enabled));
      }
      if (p.stripe.environment !== undefined) {
        plain(PAYMENT_SETTING_KEYS.STRIPE_ENVIRONMENT, p.stripe.environment);
      }
      secret(PAYMENT_SETTING_KEYS.STRIPE_SECRET_KEY, p.stripe.secretKey);
      secret(PAYMENT_SETTING_KEYS.STRIPE_WEBHOOK_SECRET, p.stripe.webhookSecret);
    }

    await saveIntegrationSettings(
      {
        systemSettingService: this.systemSettingService,
        systemSettingsCache: this.systemSettingsCache,
        txManager: this.txManager,
      },
      PAYMENT_SETTINGS_CATEGORY,
      entries,
      actorId,
      'integration_payment_settings',
      'Updated payment integration settings',
      before,
    );

    return this.getPaymentSettings();
  }

  /// Connectivity check for one provider. For `mock`, always succeeds without
  /// a network call. For a real provider, attempts an actual ₹1 order/intent
  /// creation — the standard way to verify payment-gateway credentials, since
  /// neither Razorpay's nor Stripe's API exposes a free authenticated ping
  /// endpoint; this creates a real (uncharged) order on the provider's own
  /// side, never moves money. Skipped in a test environment so the automated
  /// suite never makes a live network call.
  async testPayment(input: PaymentIntegrationTestInput = {}): Promise<IntegrationTestResult> {
    const startTime = Date.now();
    const gatewayName = input.provider ?? 'mock';

    let ok = false;
    let message: string;

    if (gatewayName === 'mock') {
      ok = true;
      message = 'Mock payment gateway reachable (no network call)';
    } else if (!PROVIDER_NAMES.includes(gatewayName)) {
      message = `Unknown payment gateway "${gatewayName}"`;
    } else {
      const settings = await this.getPaymentSettings();
      const configured = settings.providers[gatewayName].configured;
      if (!configured) {
        message = `${gatewayName} credentials are not configured`;
      } else if (isTestEnvironment()) {
        ok = true;
        message = `${gatewayName} credentials present (network call skipped in test environment)`;
      } else {
        try {
          const gateway = await this.gatewayResolver.forProviderName(gatewayName);
          await gateway.createIntent({
            amount: new Decimal(1),
            currency: 'INR',
            idempotencyKey: `admin_connectivity_test_${Date.now()}`,
            metadata: { purpose: 'admin_connectivity_test' },
          });
          ok = true;
          message = `${gatewayName} order creation succeeded`;
        } catch (err) {
          message = err instanceof Error ? err.message : `${gatewayName} connectivity check failed`;
        }
      }
    }

    const responseTimeMs = Date.now() - startTime;
    const result: IntegrationTestResult = {
      ok,
      integration: 'payment',
      provider: gatewayName,
      message,
      responseTimeMs,
    };

    await this.integrationHealthService.recordProbe('payment', gatewayName, {
      ok,
      responseTimeMs,
      message,
      configured: ok || gatewayName === 'mock',
    });

    return result;
  }

  /// Per-provider health — enabled/disabled, environment, configured,
  /// last successful/failed webhook, connectivity — for both real providers
  /// at once. The aggregate `/settings/integrations/status` endpoint shows
  /// one representative row per integration kind (matching every other
  /// integration there); this is the dedicated view for payment specifically,
  /// since Admin may want to see both Razorpay's and Stripe's health even
  /// though only one of them is ever the active gateway.
  async getPaymentProvidersHealth(): Promise<
    Record<
      Exclude<PaymentGatewayName, 'mock'>,
      {
        view: PaymentSettingsView['providers'][Exclude<PaymentGatewayName, 'mock'>];
        health: IntegrationHealthSnapshot;
      }
    >
  > {
    const settings = await this.getPaymentSettings();
    const entries = await Promise.all(
      PROVIDER_NAMES.map(async (name) => {
        const health = await this.integrationHealthService.getIntegrationStatus('payment', {
          provider: name,
          configured: settings.providers[name].configured,
        });
        return [name, { view: settings.providers[name], health }] as const;
      }),
    );
    return Object.fromEntries(entries) as Record<
      Exclude<PaymentGatewayName, 'mock'>,
      {
        view: PaymentSettingsView['providers'][Exclude<PaymentGatewayName, 'mock'>];
        health: IntegrationHealthSnapshot;
      }
    >;
  }

  getHealthFallback(view: PaymentSettingsView) {
    return {
      integration: 'payment' as const,
      provider: view.activeProvider,
      configured:
        view.activeProvider === 'mock' ||
        view.providers[view.activeProvider as Exclude<PaymentGatewayName, 'mock'>]?.configured ===
          true,
    };
  }
}
