import type { FeatureFlagStatus } from '../../../../../generated/prisma/index.js';

/// 005-razorpay-driver-payments, decisions.md TD-12 / TD-19. One kill switch per
/// payment purpose, so a recharge pilot can never open subscription payments.
/// Unlike every other seeded flag these start OFF (pilot mode starts ON): a
/// fresh database refuses all new driver payments until staff turn one on.
export const PAYMENT_FEATURE_FLAG_KEYS = Object.freeze({
  DRIVER_CHECKOUT: 'payments.driver_checkout',
  SUBSCRIPTION_CHECKOUT: 'payments.subscription_checkout',
  PILOT_MODE: 'payments.pilot_mode',
} as const);

export const PAYMENT_FEATURE_FLAG_SEED: ReadonlyArray<{
  key: string;
  name: string;
  description: string;
  defaultStatus: FeatureFlagStatus;
}> = Object.freeze([
  {
    key: PAYMENT_FEATURE_FLAG_KEYS.DRIVER_CHECKOUT,
    name: 'Driver wallet recharge payments',
    description: 'Allows new commission-wallet recharge payments through the gateway',
    defaultStatus: 'OFF',
  },
  {
    key: PAYMENT_FEATURE_FLAG_KEYS.SUBSCRIPTION_CHECKOUT,
    name: 'Driver subscription payments',
    description: 'Allows new subscription plan payments through the gateway',
    defaultStatus: 'OFF',
  },
  {
    key: PAYMENT_FEATURE_FLAG_KEYS.PILOT_MODE,
    name: 'Driver payments pilot mode',
    description:
      'Limits driver payments to the pilot allowlist. Allowlist enforcement is not active yet: keep both payment flags OFF',
    defaultStatus: 'ON',
  },
]);
