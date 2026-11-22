import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import {
  GstRecoveryConfigMissingError,
  REV5_PRICING_FLAGS,
  type FeatureFlagReader,
} from '../constants.js';
import { buildScopeLookupCandidates, pickWinningScope } from '../utils/scope-precedence.js';

export type GstRecoveryBaseRule =
  | 'PASSENGER_GST_AMOUNT'
  | 'TAXABLE_VALUE'
  | 'RIDE_SUBTOTAL_BEFORE_DISCOUNT';

export interface ResolvedGstRecoveryConfig {
  configId: string;
  familyId: string;
  version: number;
  scopeId: string;
  scopeLevel: string;
  recoveryRatePct: number;
  isEnabled: boolean;
  baseRule: GstRecoveryBaseRule;
  roundOffRupee: boolean;
  legalReference: string | null;
}

export interface GstRecoveryInputs {
  passengerGstAmount: number;
  taxableValue: number;
  rideSubtotalBeforeDiscount: number;
}

export interface GstRecoverySnapshot {
  configId: string;
  familyId: string;
  version: number;
  scopeId: string;
  scopeLevel: string;
  recoveryRatePct: number;
  isEnabled: boolean;
  baseRule: GstRecoveryBaseRule;
  roundOffRupee: boolean;
  calculationBaseAmount: number;
  recoveryAmount: number;
  legalReference: string | null;
  capturedAt: string;
}

function round2(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value * 100) / 100;
}

/// Pure deterministic driver-wallet GST recovery computation (independent from Passenger GST liability).
export function calculateGstRecovery(
  config: ResolvedGstRecoveryConfig,
  inputs: GstRecoveryInputs,
  at: Date = new Date(),
): GstRecoverySnapshot {
  if (!config.isEnabled || config.recoveryRatePct <= 0) {
    return {
      configId: config.configId,
      familyId: config.familyId,
      version: config.version,
      scopeId: config.scopeId,
      scopeLevel: config.scopeLevel,
      recoveryRatePct: config.recoveryRatePct,
      isEnabled: config.isEnabled,
      baseRule: config.baseRule,
      roundOffRupee: config.roundOffRupee,
      calculationBaseAmount: 0,
      recoveryAmount: 0,
      legalReference: config.legalReference,
      capturedAt: at.toISOString(),
    };
  }

  let calculationBaseAmount = 0;
  let rawAmount = 0;

  if (config.baseRule === 'PASSENGER_GST_AMOUNT') {
    // Recovers the exact passenger GST amount directly (when recoveryRatePct mirrors the GST rate
    // or is configured as full pass-through of passengerGstAmount).
    calculationBaseAmount = round2(inputs.passengerGstAmount);
    rawAmount = calculationBaseAmount;
  } else if (config.baseRule === 'TAXABLE_VALUE') {
    calculationBaseAmount = round2(inputs.taxableValue);
    rawAmount = (calculationBaseAmount * config.recoveryRatePct) / 100;
  } else {
    calculationBaseAmount = round2(inputs.rideSubtotalBeforeDiscount);
    rawAmount = (calculationBaseAmount * config.recoveryRatePct) / 100;
  }

  const recoveryAmount = config.roundOffRupee ? Math.round(rawAmount) : round2(rawAmount);

  return {
    configId: config.configId,
    familyId: config.familyId,
    version: config.version,
    scopeId: config.scopeId,
    scopeLevel: config.scopeLevel,
    recoveryRatePct: config.recoveryRatePct,
    isEnabled: config.isEnabled,
    baseRule: config.baseRule,
    roundOffRupee: config.roundOffRupee,
    calculationBaseAmount,
    recoveryAmount,
    legalReference: config.legalReference,
    capturedAt: at.toISOString(),
  };
}

export class GstRecoveryService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly featureFlagService: FeatureFlagReader,
  ) {}

  async isGstRecoveryEnabled(): Promise<boolean> {
    return this.featureFlagService.isEnabledReadOnly(REV5_PRICING_FLAGS.GST_RECOVERY_ENABLED);
  }

  async resolve(
    ctx: {
      cityCode?: string | null;
      serviceZoneId?: string | null;
      vehicleTypeId?: string | null;
      at?: Date;
    },
    tx?: TransactionClient,
  ): Promise<ResolvedGstRecoveryConfig> {
    const at = ctx.at ?? new Date();
    const client = tx ?? this.databaseService.client;
    const candidates = buildScopeLookupCandidates(ctx);

    const rows = await client.gstRecoveryConfigurationScope.findMany({
      where: {
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
      throw new GstRecoveryConfigMissingError(
        `city=${ctx.cityCode ?? 'GLOBAL'}, zone=${ctx.serviceZoneId ?? 'NONE'}, vehicle=${ctx.vehicleTypeId ?? 'ALL'}`,
      );
    }

    const cfg = winner.config;
    const baseRule: GstRecoveryBaseRule =
      cfg.baseRule === 'TAXABLE_VALUE' || cfg.baseRule === 'RIDE_SUBTOTAL_BEFORE_DISCOUNT'
        ? cfg.baseRule
        : 'PASSENGER_GST_AMOUNT';

    return {
      configId: cfg.id,
      familyId: cfg.familyId,
      version: cfg.version,
      scopeId: winner.id,
      scopeLevel: winner.scopeLevel,
      recoveryRatePct: Number(cfg.recoveryRatePct.toString()),
      isEnabled: cfg.isEnabled,
      baseRule,
      roundOffRupee: cfg.roundOffRupee,
      legalReference: cfg.legalReference,
    };
  }
}
