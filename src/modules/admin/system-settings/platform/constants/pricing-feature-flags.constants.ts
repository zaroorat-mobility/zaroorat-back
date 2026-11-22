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
      'Controls whether drivers can purchase or renew subscription plans (active existing subscribers continue unaffected when OFF).',
    defaultStatus: 'OFF',
  },
  {
    key: PRICING_FEATURE_FLAG_KEYS.QUOTE_LOCK,
    name: 'Enforce persisted quote lock on booking',
    description:
      'Requires a valid unexpired quoteId on ride booking and rejects stale or mismatched fares with 409.',
    defaultStatus: 'OFF',
  },
  {
    key: PRICING_FEATURE_FLAG_KEYS.SNAPSHOT_READ,
    name: 'Prefer immutable request pricing snapshot at completion',
    description:
      'Makes final fare calculation prefer ride_requests.pricing_snapshot over re-reading pricing rules or env defaults.',
    defaultStatus: 'OFF',
  },
  {
    key: PRICING_FEATURE_FLAG_KEYS.CANCELLATION_POLICY_ENFORCEMENT,
    name: 'Enforce versioned cancellation policies on rides',
    description:
      'Assesses cancellation fees and driver compensation using active versioned cancellation policies from Pricing Management.',
    defaultStatus: 'OFF',
  },
  {
    key: PRICING_FEATURE_FLAG_KEYS.COMMISSION_CONFIG_SOURCE,
    name: 'Read central commission rates from PostgreSQL',
    description:
      'Resolves commission strictly from active commission configurations in GST & Taxation; requires an active Global commission baseline.',
    defaultStatus: 'OFF',
  },
  {
    key: PRICING_FEATURE_FLAG_KEYS.WALLET_RESERVATION_ENABLED,
    name: 'Enforce atomic accept-time driver wallet reservations',
    description:
      'Reserves expected commission and GST recovery at accept time and protects active reservations from manual debits/refunds.',
    defaultStatus: 'OFF',
  },
  {
    key: PRICING_FEATURE_FLAG_KEYS.COMMISSION_WALLET_DEDUCTION,
    name: 'Post-completion commission wallet deduction',
    description:
      'Executes post-completion ride commission wallet debit with settlement step & failure tracking (requires Snapshot Read, Commission Config Source, and Wallet Reservation).',
    defaultStatus: 'OFF',
  },
  {
    key: PRICING_FEATURE_FLAG_KEYS.PASSENGER_GST_ENABLED,
    name: 'Enable passenger ride GST calculation',
    description:
      'Computes CGST/SGST/IGST from active GST & Taxation rules and registered company GSTIN (requires Snapshot Read, active Passenger GST rate, and active Company GSTIN).',
    defaultStatus: 'OFF',
  },
  {
    key: PRICING_FEATURE_FLAG_KEYS.GST_RECOVERY_ENABLED,
    name: 'Enable driver wallet GST recovery debit',
    description:
      'Posts independent post-completion ride GST recovery wallet debit from driver commission wallet (requires Passenger GST, Wallet Reservation, and Snapshot Read).',
    defaultStatus: 'OFF',
  },
  {
    key: PRICING_FEATURE_FLAG_KEYS.DOCUMENTS_ISSUE,
    name: 'Issue numbered fiscal documents & signed PDFs',
    description:
      'Automatically issues gapless numbered Tax Invoices, Commission Invoices, and Wallet Recharge Receipts as signed A4 PDFs (requires active Company GSTIN and Document Series).',
    defaultStatus: 'OFF',
  },
]);
