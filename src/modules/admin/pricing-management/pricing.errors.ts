export class PricingAdminError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(message: string, code = 'PRICING_ADMIN_ERROR', statusCode = 400) {
    super(message);
    this.name = 'PricingAdminError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class FareRuleNotFoundError extends PricingAdminError {
  constructor(message = 'Fare rule was not found') {
    super(message, 'FARE_RULE_NOT_FOUND', 404);
    this.name = 'FareRuleNotFoundError';
  }
}

export class FareRuleConflictError extends PricingAdminError {
  constructor(message: string) {
    super(message, 'FARE_RULE_CONFLICT', 409);
    this.name = 'FareRuleConflictError';
  }
}

export class CancellationPolicyNotFoundError extends PricingAdminError {
  constructor(message = 'Cancellation policy was not found') {
    super(message, 'CANCELLATION_POLICY_NOT_FOUND', 404);
    this.name = 'CancellationPolicyNotFoundError';
  }
}

export class CancellationPolicyConflictError extends PricingAdminError {
  constructor(message: string) {
    super(message, 'CANCELLATION_POLICY_CONFLICT', 409);
    this.name = 'CancellationPolicyConflictError';
  }
}

export class InvoiceNotFoundError extends PricingAdminError {
  constructor(id?: string) {
    super(id ? `Invoice ${id} was not found` : 'Invoice was not found', 'INVOICE_NOT_FOUND', 404);
    this.name = 'InvoiceNotFoundError';
  }
}

export class InvoiceTemplateNotFoundError extends PricingAdminError {
  constructor(id?: string) {
    super(
      id ? `Invoice template ${id} was not found` : 'Invoice template was not found',
      'INVOICE_TEMPLATE_NOT_FOUND',
      404,
    );
    this.name = 'InvoiceTemplateNotFoundError';
  }
}

/// FR-033. `updateSurgeZone` wrote through raw `UPDATE`s that matched no rows
/// when the id did not exist, then returned `{ success: true }`. An operator
/// editing a deleted zone was told the edit had been applied.
export class SurgeZoneNotFoundError extends PricingAdminError {
  constructor(message = 'Surge zone was not found') {
    super(message, 'SURGE_ZONE_NOT_FOUND', 404);
    this.name = 'SurgeZoneNotFoundError';
  }
}

export class SurgeWindowNotFoundError extends PricingAdminError {
  constructor(message = 'Surge window was not found') {
    super(message, 'SURGE_WINDOW_NOT_FOUND', 404);
    this.name = 'SurgeWindowNotFoundError';
  }
}
