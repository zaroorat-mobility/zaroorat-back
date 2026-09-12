export const PAYMENT_SETTINGS_CATEGORY = 'integrations.payment';
export const SMS_SETTINGS_CATEGORY = 'integrations.sms';
export const PUSH_SETTINGS_CATEGORY = 'integrations.push';
export const EMAIL_SETTINGS_CATEGORY = 'integrations.email';

export const INTEGRATION_HEALTH_SNAPSHOT_PREFIX = 'integration:health:snapshot';
export const INTEGRATION_HEALTH_HISTORY_PREFIX = 'integration:health:history';
export const INTEGRATION_HEALTH_HISTORY_MAX = 20;
export const INTEGRATION_HEALTH_TTL_SECONDS = 86_400;

export const PAYMENT_SETTING_KEYS = {
  DEFAULT_GATEWAY: 'payment.default_gateway',
  DEFAULT_CURRENCY: 'payment.default_currency',
  /// Legacy single-secret fallback (`readWebhookSecret` in payment.config.ts).
  /// Superseded by a per-provider secret below; kept so a deployment that only
  /// ever set one shared secret keeps working unchanged.
  WEBHOOK_SECRET: 'payment.webhook_secret',

  /// The ONE admin-configured gateway used for every NEW PaymentIntent —
  /// driver subscription payments, Commission Wallet recharges, and a
  /// customer's own wallet top-up. There is no per-purpose routing and no
  /// per-driver selection: whichever provider is active handles all of it,
  /// automatically. Never consulted for an existing intent
  /// (PaymentIntent.gateway, fixed at creation, is authoritative for that).
  ///
  /// There is deliberately no key for a customer's ride fare: the customer
  /// pays the driver directly (cash/UPI/card outside the platform), never
  /// through a gateway, so there is nothing here for that money to route to.
  ACTIVE_PROVIDER: 'payment.active_provider',

  RAZORPAY_ENABLED: 'payment.razorpay.enabled',
  RAZORPAY_ENVIRONMENT: 'payment.razorpay.environment',
  RAZORPAY_KEY_ID: 'payment.razorpay_key_id',
  RAZORPAY_KEY_SECRET: 'payment.razorpay_key_secret',
  RAZORPAY_WEBHOOK_SECRET: 'payment.razorpay.webhook_secret',

  STRIPE_ENABLED: 'payment.stripe.enabled',
  STRIPE_ENVIRONMENT: 'payment.stripe.environment',
  STRIPE_SECRET_KEY: 'payment.stripe_secret_key',
  STRIPE_WEBHOOK_SECRET: 'payment.stripe.webhook_secret',
} as const;

// Cashfree is deliberately absent: not exposed or selectable for now.
export const PAYMENT_GATEWAY_NAMES = ['mock', 'razorpay', 'stripe'] as const;

export const SMS_SETTING_KEYS = {
  PROVIDER: 'sms.provider',
  MSG91_AUTH_KEY: 'sms.msg91_auth_key',
  MSG91_SENDER_ID: 'sms.msg91_sender_id',
  MSG91_OTP_TEMPLATE_ID: 'sms.msg91_otp_template_id',
  TIMEOUT_MS: 'sms.timeout_ms',
} as const;

export const PUSH_SETTING_KEYS = {
  PROVIDER: 'push.provider',
  FCM_SERVER_KEY: 'push.fcm_server_key',
} as const;

export const EMAIL_SETTING_KEYS = {
  PROVIDER: 'email.provider',
  SMTP_HOST: 'email.smtp_host',
  SMTP_PORT: 'email.smtp_port',
  SMTP_USER: 'email.smtp_user',
  SMTP_PASSWORD: 'email.smtp_password',
  FROM_ADDRESS: 'email.from_address',
} as const;

export type IntegrationKind = 'payment' | 'sms' | 'push' | 'email' | 'maps';
