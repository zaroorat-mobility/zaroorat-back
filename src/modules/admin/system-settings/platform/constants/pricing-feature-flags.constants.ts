import type { FeatureFlagStatus } from '../../../../../generated/prisma/index.js';
import { CANCELLATION_POLICY_ENFORCEMENT_FLAG } from '@modules/pricing/constants.js';

/// Phase 1–4 pricing governance feature flags.
/// Every pricing enforcement and financial deduction flag starts OFF by default.
export const PRICING_FEATURE_FLAG_KEYS = Object.freeze({
  QUOTE_LOCK: 'pricing.quote_lock',
  SNAPSHOT_READ: 'pricing.snapshot_read',
  CANCELLATION_POLICY_ENFORCEMENT: CANCELLATION_POLICY_ENFORCEMENT_FLAG,
} as const);

export const PRICING_FEATURE_FLAG_SEED: ReadonlyArray<{
  key: string;
  name: string;
  description: string;
  defaultStatus: FeatureFlagStatus;
}> = Object.freeze([
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
      'Assesses cancellation fees and driver compensation using active versioned cancellation_policies instead of legacy env defaults (records ASSESSED; does not auto-collect)',
    defaultStatus: 'OFF',
  },
]);
