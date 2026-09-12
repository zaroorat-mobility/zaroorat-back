import type { IntegrationKind } from '../constants/integration-settings.constants.js';

export type IntegrationHealthStatus = 'HEALTHY' | 'WARNING' | 'CRITICAL' | 'DOWN';

// Cashfree is deliberately absent: not exposed or selectable for now.
export type PaymentGatewayName = 'mock' | 'razorpay' | 'stripe';
export type PaymentEnvironment = 'sandbox' | 'live';
export type SmsProviderName = 'mock' | 'msg91';
export type PushProviderName = 'mock';
export type EmailProviderName = 'smtp';

export interface PaymentProviderView {
  enabled: boolean;
  environment: PaymentEnvironment;
  /// True once every credential this provider needs to make a real API call
  /// is present (admin setting or env fallback) — never reveals the values
  /// themselves, only whether they exist.
  configured: boolean;
  webhookConfigured: boolean;
}

export interface PaymentSettingsView {
  defaultCurrency: string;
  version: number;
  /// The ONE provider every NEW PaymentIntent uses — subscription payments,
  /// Commission Wallet recharges, wallet top-ups, all of it. Applies only
  /// going forward — an existing PaymentIntent keeps whatever provider it was
  /// created with (`PaymentIntent.gateway`), unaffected by a later change here.
  activeProvider: PaymentGatewayName;
  providers: {
    razorpay: PaymentProviderView & { keyId: string; keySecret: string; webhookSecret: string };
    stripe: PaymentProviderView & { secretKey: string; webhookSecret: string };
  };
}

export interface UpdatePaymentSettingsBody {
  defaultCurrency?: string;
  /// 'mock' stays selectable for test/staging use, matching the same
  /// escape hatch every provider field already had — never Cashfree, which is
  /// not exposed at all.
  activeProvider?: PaymentGatewayName;
  providers?: {
    razorpay?: {
      enabled?: boolean;
      environment?: PaymentEnvironment;
      keyId?: string;
      keySecret?: string;
      webhookSecret?: string;
    };
    stripe?: {
      enabled?: boolean;
      environment?: PaymentEnvironment;
      secretKey?: string;
      webhookSecret?: string;
    };
  };
  expectedVersion?: number;
}

export interface SmsSettingsView {
  provider: SmsProviderName;
  configured: boolean;
  version: number;
  msg91: {
    authKey: string;
    senderId: string;
    otpTemplateId: string;
    timeoutMs: number;
    configured: boolean;
  };
}

export interface UpdateSmsSettingsBody {
  provider?: SmsProviderName;
  msg91AuthKey?: string;
  msg91SenderId?: string;
  msg91OtpTemplateId?: string;
  timeoutMs?: number;
  expectedVersion?: number;
}

export interface PushSettingsView {
  provider: PushProviderName;
  configured: boolean;
  version: number;
  fcm: {
    serverKey: string;
    configured: boolean;
  };
}

export interface UpdatePushSettingsBody {
  provider?: PushProviderName;
  fcmServerKey?: string;
  expectedVersion?: number;
}

export interface EmailSettingsView {
  provider: EmailProviderName;
  configured: boolean;
  version: number;
  smtp: {
    host: string;
    port: number;
    user: string;
    password: string;
    fromAddress: string;
    configured: boolean;
  };
}

export interface UpdateEmailSettingsBody {
  provider?: EmailProviderName;
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpPassword?: string;
  fromAddress?: string;
  expectedVersion?: number;
}

export interface IntegrationTestInput {
  testPhone?: string;
  testEmail?: string;
}

export interface IntegrationTestResult {
  ok: boolean;
  integration: IntegrationKind;
  provider: string;
  message: string;
  responseTimeMs: number;
}

export interface IntegrationHealthSnapshot {
  integration: IntegrationKind;
  provider: string;
  status: IntegrationHealthStatus;
  configured: boolean;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  recentFailureCount: number;
  p95ResponseTimeMs: number | null;
  message: string;
  probedAt: string | null;
}

export interface IntegrationsStatusView {
  overall: IntegrationHealthStatus;
  integrations: IntegrationHealthSnapshot[];
}

export interface MapClientConfigProviderView {
  enabled: boolean;
  baseUrl: string;
  /**
   * Browser-publishable client SDK key for the active provider. Named to match
   * the public `/api/v1/maps/config` field: the same credential, one name. It is
   * never a server REST key -- those stay server-side.
   */
  clientSdkKey?: string;
  /** Optional raster tile template (Leaflet `{z}/{x}/{y}` placeholders). */
  tileUrl?: string;
}

export interface MapClientConfigView {
  primaryProvider: string;
  providers: {
    ola: MapClientConfigProviderView;
    google: MapClientConfigProviderView;
    mappls: MapClientConfigProviderView;
  };
}
