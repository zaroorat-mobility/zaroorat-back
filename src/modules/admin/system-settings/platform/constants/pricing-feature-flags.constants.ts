import type { FeatureFlagStatus } from '../../../../../generated/prisma/index.js';
import { REV5_PRICING_FLAGS } from '@modules/pricing/constants.js';

/// Phase 1–4 pricing governance feature flags (Rev 5 §1.3).
/// Every pricing enforcement and financial deduction flag starts OFF by default.
export const PRICING_FEATURE_FLAG_KEYS = REV5_PRICING_FLAGS;

export const PRICING_FEATURE_FLAG_SEED: ReadonlyArray<{
  key: string;
  name: string;
  description: string;
  defaultStatus: FeatureFlagStatus;
}> = Object.freeze([
  {
    key: PRICING_FEATURE_FLAG_KEYS.SUBSCRIPTION_MODEL_ENABLED,
    name: 'Enable new driver subscription onboarding & renewals',
    description:
      'Locked OFF per Owner D-11: blocks new subscription purchases/renewals while preserving grandfathered active subscribers',
    defaultStatus: 'OFF',
  },
  {
    key: PRICING_FEATURE_FLAG_KEYS.QUOTE_LOCK,
    name: 'Enforce persisted quote lock on booking',
    description:
      'Requires a valid unexpired quoteId on ride booking and rejects stale or mismatched fares with 409',
    defaultStatus: 'OFF',
  },
  {
    key: PRICING_FEATURE_FLAG_KEYS.SNAPSHOT_READ,
    name: 'Prefer immutable request pricing snapshot at completion',
    description:
      'Makes final fare calculation prefer ride_requests.pricing_snapshot over re-reading pricing rules or env defaults',
    defaultStatus: 'OFF',
  },
  {
    key: PRICING_FEATURE_FLAG_KEYS.CANCELLATION_POLICY_ENFORCEMENT,
    name: 'Enforce versioned cancellation policies on rides',
    description:
      'Assesses cancellation fees and driver compensation using active versioned cancellation_policies instead of legacy env defaults',
    defaultStatus: 'OFF',
  },
  {
    key: PRICING_FEATURE_FLAG_KEYS.COMMISSION_CONFIG_SOURCE,
    name: 'Read central commission rates from PostgreSQL (fail-closed)',
    description:
      'Resolves commission strictly from active commission_configurations scopes; fails closed with 503 if unconfigured',
    defaultStatus: 'OFF',
  },
  {
    key: PRICING_FEATURE_FLAG_KEYS.WALLET_RESERVATION_ENABLED,
    name: 'Enforce atomic accept-time driver wallet reservations',
    description:
      'Reserves expected commission + GST recovery at accept time and protects active reservations from manual debits/refunds',
    defaultStatus: 'OFF',
  },
  {
    key: PRICING_FEATURE_FLAG_KEYS.COMMISSION_WALLET_DEDUCTION,
    name: 'Post-completion commission wallet deduction (Rev 5 G1)',
    description:
      'Executes post-completion RIDE_COMMISSION wallet debit with settlement step & failure tracking (requires reservation + DB config)',
    defaultStatus: 'OFF',
  },
  {
    key: PRICING_FEATURE_FLAG_KEYS.PASSENGER_GST_ENABLED,
    name: 'Enable passenger ride GST calculation & single TAX_PAYABLE liability (Rev 5 G2)',
    description:
      'Computes CGST/SGST/IGST from CA-approved tax_configurations and multi-state legal registrations; requires D-20 if recovery is OFF',
    defaultStatus: 'OFF',
  },
  {
    key: PRICING_FEATURE_FLAG_KEYS.GST_RECOVERY_ENABLED,
    name: 'Enable driver wallet GST recovery debit (Rev 5 G3)',
    description:
      'Posts independent post-completion RIDE_GST_RECOVERY wallet debit clearing DRIVER_GST_RECOVERY_CLEARING (requires passenger GST + reservation)',
    defaultStatus: 'OFF',
  },
  {
    key: PRICING_FEATURE_FLAG_KEYS.DOCUMENTS_ISSUE,
    name: 'Issue numbered fiscal documents & signed PDFs',
    description:
      'Phase 6 outbox issuance of gapless numbered fiscal documents per GST registration (gated on CA D-06 & PDF renderer)',
    defaultStatus: 'OFF',
  },
]);
