import type { IntegrationKind } from '../constants/integration-settings.constants.js';

export type IntegrationHealthStatus = 'HEALTHY' | 'WARNING' | 'CRITICAL' | 'DOWN';

export type PaymentGatewayName = 'mock' | 'razorpay' | 'stripe';
export type SmsProviderName = 'mock' | 'msg91';
export type PushProviderName = 'mock';
export type EmailProviderName = 'smtp';

export interface PaymentSettingsView {
  defaultGateway: PaymentGatewayName;
  defaultCurrency: string;
  configured: boolean;
  webhookConfigured: boolean;
  version: number;
  razorpay: {
    keyId: string;
    keySecret: string;
    configured: boolean;
  };
  stripe: {
    secretKey: string;
    configured: boolean;
  };
}

export interface UpdatePaymentSettingsBody {
  defaultGateway?: PaymentGatewayName;
  defaultCurrency?: string;
  razorpayKeyId?: string;
  razorpayKeySecret?: string;
  stripeSecretKey?: string;
  webhookSecret?: string;
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
  /** Client-side tile key for the active provider (browser tile requests require this). */
  apiKey?: string;
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
