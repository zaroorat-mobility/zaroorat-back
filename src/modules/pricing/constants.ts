/// The `PricingRule.cityCode` every category falls back to when no city has a
/// rate card of its own. Mirrors the value the catalog seed writes; kept here
/// rather than imported from `prisma/seed` so nothing in `src/` depends on the
/// seed scripts.
export const GLOBAL_PRICING_CITY_CODE = 'GLOBAL';

/// Sentinel values for normalized child `*_configuration_scopes` tables (Rev 5 R5-3).
export const SCOPE_GLOBAL_CITY = '__GLOBAL__' as const;
export const SCOPE_NIL_UUID = '00000000-0000-0000-0000-000000000000' as const;

/// Shared feature flag keys (layering boundary: domain pricing never imports from `modules/admin`).
export const SURGE_FEATURE_FLAG_KEY = 'surge' as const;
export const CANCELLATION_POLICY_ENFORCEMENT_FLAG = 'cancellation.policy_enforcement' as const;

export const REV5_PRICING_FLAGS = Object.freeze({
  SUBSCRIPTION_MODEL_ENABLED: 'drivers.subscription_model_enabled',
  QUOTE_LOCK: 'pricing.quote_lock',
  SNAPSHOT_READ: 'pricing.snapshot_read',
  CANCELLATION_POLICY_ENFORCEMENT: CANCELLATION_POLICY_ENFORCEMENT_FLAG,
  COMMISSION_CONFIG_SOURCE: 'pricing.commission_config_source',
  WALLET_RESERVATION_ENABLED: 'pricing.wallet_reservation_enabled',
  COMMISSION_WALLET_DEDUCTION: 'pricing.commission_wallet_deduction',
  PASSENGER_GST_ENABLED: 'pricing.passenger_gst_enabled',
  GST_RECOVERY_ENABLED: 'pricing.gst_recovery_enabled',
  DOCUMENTS_ISSUE: 'documents.issue',
} as const);

export interface FeatureFlagReader {
  isOn(key: string): Promise<boolean>;
  isEnabledReadOnly(key: string): Promise<boolean>;
}

/// Fail-closed runtime pricing & tax errors (Rev 5 §1.2, §1.4).
export class PricingGovernanceError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(message: string, code: string, statusCode: number) {
    super(message);
    this.name = 'PricingGovernanceError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class CommissionConfigMissingError extends PricingGovernanceError {
  constructor(scopeHint = 'requested scope') {
    super(
      `No active commission configuration found for ${scopeHint}. Refusing silent fallback.`,
      'COMMISSION_CONFIG_MISSING',
      503,
    );
    this.name = 'CommissionConfigMissingError';
  }
}

export class TaxConfigMissingError extends PricingGovernanceError {
  constructor(scopeHint = 'requested scope') {
    super(
      `No active CA-approved tax configuration found for ${scopeHint}. Refusing silent fallback.`,
      'TAX_CONFIG_MISSING',
      503,
    );
    this.name = 'TaxConfigMissingError';
  }
}

export class GstRecoveryConfigMissingError extends PricingGovernanceError {
  constructor(scopeHint = 'requested scope') {
    super(
      `No active GST recovery configuration found for ${scopeHint}. Refusing silent fallback.`,
      'GST_RECOVERY_CONFIG_MISSING',
      503,
    );
    this.name = 'GstRecoveryConfigMissingError';
  }
}

export class TaxJurisdictionIncompleteError extends PricingGovernanceError {
  constructor(cityCode: string, detail?: string) {
    super(
      `Tax jurisdiction registration incomplete for city '${cityCode}'${detail ? `: ${detail}` : ''}.`,
      'TAX_JURISDICTION_INCOMPLETE',
      503,
    );
    this.name = 'TaxJurisdictionIncompleteError';
  }
}

export class FlagDependencyUnsatisfiedError extends PricingGovernanceError {
  constructor(message: string) {
    super(message, 'FLAG_DEPENDENCY_UNSATISFIED', 409);
    this.name = 'FlagDependencyUnsatisfiedError';
  }
}

export class NonRecoveryGstContraUnapprovedError extends PricingGovernanceError {
  constructor(message: string) {
    super(message, 'NON_RECOVERY_GST_CONTRA_UNAPPROVED', 409);
    this.name = 'NonRecoveryGstContraUnapprovedError';
  }
}

export class FlagDependencyActiveError extends PricingGovernanceError {
  constructor(message: string) {
    super(message, 'FLAG_DEPENDENCY_ACTIVE', 409);
    this.name = 'FlagDependencyActiveError';
  }
}
