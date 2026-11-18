import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import {
  REV5_PRICING_FLAGS,
  TaxConfigMissingError,
  TaxJurisdictionIncompleteError,
  type FeatureFlagReader,
} from '../constants.js';
import { buildScopeLookupCandidates, pickWinningScope } from '../utils/scope-precedence.js';

export type TaxKind = 'PASSENGER_RIDE_GST' | 'COMMISSION_GST';
export type TaxSupplyType = 'INTRA_STATE' | 'INTER_STATE';

export interface ResolvedTaxConfig {
  configId: string;
  familyId: string;
  version: number;
  kind: TaxKind;
  scopeId: string;
  scopeLevel: string;
  ratePct: number;
  isEnabled: boolean;
  inclusive: boolean;
  waitingTaxable: boolean;
  sacCode: string;
  legalReference: string;
}

export interface ResolvedTaxJurisdiction {
  legalEntityId: string;
  legalEntityName: string;
  pan: string;
  gstRegistrationId: string;
  supplierGstin: string;
  supplierStateCode: string;
  supplierStateName: string;
  placeOfSupplyCityCode: string;
  placeOfSupplyStateCode: string;
  placeOfSupplyStateName: string | null;
  supplyType: TaxSupplyType;
}

export interface PassengerGstFareInputs {
  /// Surged ride subtotal (base + distance + time + surge, after min-fare floor & applicable discount)
  rideSubtotal: number;
  /// Billable waiting charge (included in taxable value iff `waitingTaxable === true`)
  waitingCharge: number;
  /// Booking fee (if any; ₹0 per Rev 5)
  bookingFee: number;
}

export interface PassengerGstSnapshot {
  configId: string;
  familyId: string;
  version: number;
  scopeId: string;
  scopeLevel: string;
  kind: 'PASSENGER_RIDE_GST';
  ratePct: number;
  isEnabled: boolean;
  inclusive: boolean;
  waitingTaxable: boolean;
  sacCode: string;
  legalReference: string;
  jurisdiction: ResolvedTaxJurisdiction;
  nonTaxableWaitingAmount: number;
  taxableValue: number;
  totalTaxAmount: number;
  cgstRatePct: number;
  cgstAmount: number;
  sgstRatePct: number;
  sgstAmount: number;
  igstRatePct: number;
  igstAmount: number;
  grossCustomerFare: number;
  capturedAt: string;
}

function round2(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value * 100) / 100;
}

/// Pure deterministic passenger GST calculation implementing ALL FOUR Rev 5 §4.2 variants:
/// - Variant 1A (`waitingTaxable=true`,  `inclusive=false`): Taxable = rideSubtotal + waiting + bookingFee
/// - Variant 1B (`waitingTaxable=true`,  `inclusive=true`):  Gross = rideSubtotal + waiting + bookingFee; Taxable = Gross / (1 + r)
/// - Variant 2A (`waitingTaxable=false`, `inclusive=false`): Taxable = rideSubtotal + bookingFee; nonTaxableWaiting = waiting
/// - Variant 2B (`waitingTaxable=false`, `inclusive=true`):  Taxable = (rideSubtotal + bookingFee) / (1 + r); Gross = rideSubtotal + bookingFee + waiting
/// Splits CGST/SGST (intra-state) vs. IGST (inter-state) strictly from supplier vs. supply state codes.
export function calculatePassengerGst(
  config: ResolvedTaxConfig,
  jurisdiction: ResolvedTaxJurisdiction,
  fare: PassengerGstFareInputs,
  at: Date = new Date(),
): PassengerGstSnapshot {
  const nonTaxableWaitingAmount = config.waitingTaxable ? 0 : round2(fare.waitingCharge);
  const taxablePool = round2(
    fare.rideSubtotal + fare.bookingFee + (config.waitingTaxable ? fare.waitingCharge : 0),
  );

  if (!config.isEnabled || config.ratePct <= 0 || taxablePool <= 0) {
    const gross = round2(fare.rideSubtotal + fare.bookingFee + fare.waitingCharge);
    return {
      configId: config.configId,
      familyId: config.familyId,
      version: config.version,
      scopeId: config.scopeId,
      scopeLevel: config.scopeLevel,
      kind: 'PASSENGER_RIDE_GST',
      ratePct: config.ratePct,
      isEnabled: config.isEnabled,
      inclusive: config.inclusive,
      waitingTaxable: config.waitingTaxable,
      sacCode: config.sacCode,
      legalReference: config.legalReference,
      jurisdiction,
      nonTaxableWaitingAmount,
      taxableValue: taxablePool,
      totalTaxAmount: 0,
      cgstRatePct: 0,
      cgstAmount: 0,
      sgstRatePct: 0,
      sgstAmount: 0,
      igstRatePct: 0,
      igstAmount: 0,
      grossCustomerFare: gross,
      capturedAt: at.toISOString(),
    };
  }

  let taxableValue: number;
  let totalTaxAmount: number;
  let grossCustomerFare: number;

  if (config.inclusive) {
    taxableValue = round2(taxablePool / (1 + config.ratePct / 100));
    totalTaxAmount = round2(taxablePool - taxableValue);
    grossCustomerFare = round2(taxablePool + nonTaxableWaitingAmount);
  } else {
    taxableValue = taxablePool;
    totalTaxAmount = round2((taxableValue * config.ratePct) / 100);
    grossCustomerFare = round2(taxableValue + totalTaxAmount + nonTaxableWaitingAmount);
  }

  let cgstRatePct = 0;
  let cgstAmount = 0;
  let sgstRatePct = 0;
  let sgstAmount = 0;
  let igstRatePct = 0;
  let igstAmount = 0;

  if (jurisdiction.supplyType === 'INTRA_STATE') {
    const halfRate = round2(config.ratePct / 2);
    cgstRatePct = halfRate;
    sgstRatePct = round2(config.ratePct - halfRate);
    // Deterministic odd-paise split: CGST takes ceil-half paise, SGST takes remainder
    // so cgstAmount + sgstAmount === totalTaxAmount to the exact paisa.
    const totalPaise = Math.round(totalTaxAmount * 100);
    const cgstPaise = Math.ceil(totalPaise / 2);
    const sgstPaise = totalPaise - cgstPaise;
    cgstAmount = cgstPaise / 100;
    sgstAmount = sgstPaise / 100;
  } else {
    igstRatePct = config.ratePct;
    igstAmount = totalTaxAmount;
  }

  return {
    configId: config.configId,
    familyId: config.familyId,
    version: config.version,
    scopeId: config.scopeId,
    scopeLevel: config.scopeLevel,
    kind: 'PASSENGER_RIDE_GST',
    ratePct: config.ratePct,
    isEnabled: config.isEnabled,
    inclusive: config.inclusive,
    waitingTaxable: config.waitingTaxable,
    sacCode: config.sacCode,
    legalReference: config.legalReference,
    jurisdiction,
    nonTaxableWaitingAmount,
    taxableValue,
    totalTaxAmount,
    cgstRatePct,
    cgstAmount,
    sgstRatePct,
    sgstAmount,
    igstRatePct,
    igstAmount,
    grossCustomerFare,
    capturedAt: at.toISOString(),
  };
}

export class TaxService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly featureFlagService: FeatureFlagReader,
  ) {}

  async isPassengerGstEnabled(): Promise<boolean> {
    return this.featureFlagService.isEnabledReadOnly(REV5_PRICING_FLAGS.PASSENGER_GST_ENABLED);
  }

  /// Resolves the CA-approved tax configuration for the requested scope and tax kind.
  /// Fails closed (503 TAX_CONFIG_MISSING) if absent or missing SAC / waitingTaxable / legalReference.
  async resolveConfig(
    ctx: {
      kind: TaxKind;
      cityCode?: string | null;
      serviceZoneId?: string | null;
      vehicleTypeId?: string | null;
      at?: Date;
    },
    tx?: TransactionClient,
  ): Promise<ResolvedTaxConfig> {
    const at = ctx.at ?? new Date();
    const client = tx ?? this.databaseService.client;
    const candidates = buildScopeLookupCandidates(ctx);

    const rows = await client.taxConfigurationScope.findMany({
      where: {
        taxKind: ctx.kind,
        isEnforced: true,
        effectiveFrom: { lte: at },
        AND: [
          { OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }] },
          { OR: candidates },
        ],
      },
      include: { config: true },
    });

    const winner = pickWinningScope(rows);
    if (!winner) {
      throw new TaxConfigMissingError(
        `kind=${ctx.kind}, city=${ctx.cityCode ?? 'GLOBAL'}, vehicle=${ctx.vehicleTypeId ?? 'ALL'}`,
      );
    }

    const cfg = winner.config;
    if (
      !cfg.sacCode ||
      cfg.sacCode.trim().length < 4 ||
      cfg.waitingTaxable === null ||
      !cfg.legalReference
    ) {
      throw new TaxConfigMissingError(
        `config ${cfg.id} is missing CA-approved sacCode, waitingTaxable, or legalReference`,
      );
    }

    return {
      configId: cfg.id,
      familyId: cfg.familyId,
      version: cfg.version,
      kind: cfg.kind as TaxKind,
      scopeId: winner.id,
      scopeLevel: winner.scopeLevel,
      ratePct: Number(cfg.ratePct.toString()),
      isEnabled: cfg.isEnabled,
      inclusive: cfg.inclusive,
      waitingTaxable: cfg.waitingTaxable,
      sacCode: cfg.sacCode.trim(),
      legalReference: cfg.legalReference,
    };
  }

  /// Resolves actual legal entity, supplier state GSTIN, and place-of-supply state code.
  /// Never assumes a single head-office state code; fails closed (503 TAX_JURISDICTION_INCOMPLETE).
  async resolveJurisdiction(
    ctx: {
      cityCode: string;
      supplyKind: 'PASSENGER_RIDE' | 'PLATFORM_COMMISSION';
      at?: Date;
    },
    tx?: TransactionClient,
  ): Promise<ResolvedTaxJurisdiction> {
    const at = ctx.at ?? new Date();
    const client = tx ?? this.databaseService.client;

    const [city, mapping] = await Promise.all([
      client.city.findUnique({ where: { code: ctx.cityCode } }),
      client.citySupplyRegistration.findFirst({
        where: {
          cityCode: ctx.cityCode,
          supplyKind: ctx.supplyKind,
          isActive: true,
          effectiveFrom: { lte: at },
          OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
        },
        include: {
          legalEntity: true,
          gstRegistration: true,
        },
      }),
    ]);

    if (!city || !city.stateCode || city.stateCode.trim().length !== 2) {
      throw new TaxJurisdictionIncompleteError(
        ctx.cityCode,
        'city record or 2-digit GST state_code is missing',
      );
    }

    if (!mapping || !mapping.legalEntity.isActive || !mapping.gstRegistration.isActive) {
      throw new TaxJurisdictionIncompleteError(
        ctx.cityCode,
        `no active city_supply_registrations row for supplyKind=${ctx.supplyKind}`,
      );
    }

    const reg = mapping.gstRegistration;
    if (reg.effectiveFrom > at || (reg.effectiveTo && reg.effectiveTo <= at)) {
      throw new TaxJurisdictionIncompleteError(
        ctx.cityCode,
        `GST registration ${reg.gstin} is outside its effective window`,
      );
    }

    const supplierStateCode = reg.stateCode.trim().toUpperCase();
    const placeOfSupplyStateCode = city.stateCode.trim().toUpperCase();
    const supplyType: TaxSupplyType =
      supplierStateCode === placeOfSupplyStateCode ? 'INTRA_STATE' : 'INTER_STATE';

    return {
      legalEntityId: mapping.legalEntity.id,
      legalEntityName: mapping.legalEntity.legalEntityName,
      pan: mapping.legalEntity.pan,
      gstRegistrationId: reg.id,
      supplierGstin: reg.gstin,
      supplierStateCode,
      supplierStateName: reg.stateName,
      placeOfSupplyCityCode: city.code,
      placeOfSupplyStateCode,
      placeOfSupplyStateName: city.stateName ?? city.state ?? null,
      supplyType,
    };
  }
}
