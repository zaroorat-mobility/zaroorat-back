import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import {
  CommissionConfigMissingError,
  REV5_PRICING_FLAGS,
  type FeatureFlagReader,
} from '../constants.js';
import { buildScopeLookupCandidates, pickWinningScope } from '../utils/scope-precedence.js';

export type CommissionBaseRule =
  | 'RIDE_SUBTOTAL_BEFORE_DISCOUNT'
  | 'RIDE_SUBTOTAL_AFTER_DISCOUNT'
  | 'PRE_TAX_TOTAL';

export interface CommissionFareInputs {
  baseFare: number;
  distanceFare: number;
  timeFare: number;
  surgeAmount: number;
  waitingCharge: number;
  bookingFee: number;
  minimumFare: number;
  discountAmount: number;
}

export interface ResolvedCommissionConfig {
  configId: string;
  familyId: string;
  version: number;
  scopeId: string;
  scopeLevel: string;
  cityCode: string;
  serviceZoneId: string;
  vehicleTypeId: string;
  commissionRatePct: number;
  isEnabled: boolean;
  baseRule: CommissionBaseRule;
  includeSurge: boolean;
  includeWaiting: boolean;
  includeBookingFee: boolean;
  applyMinimumFloor: boolean;
  roundOffRupee: boolean;
}

export interface CommissionSnapshot {
  configId: string;
  familyId: string;
  version: number;
  scopeId: string;
  scopeLevel: string;
  commissionRatePct: number;
  isEnabled: boolean;
  baseRule: CommissionBaseRule;
  includeSurge: boolean;
  includeWaiting: boolean;
  includeBookingFee: boolean;
  applyMinimumFloor: boolean;
  roundOffRupee: boolean;
  calculationBaseAmount: number;
  commissionAmount: number;
  capturedAt: string;
}

function round2(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value * 100) / 100;
}

/// Pure deterministic commission math matching Rev 5 §4.2 worked example.
/// Never hardcodes any fallback percentage; rate comes strictly from `config`.
export function calculateCommission(
  config: ResolvedCommissionConfig,
  fare: CommissionFareInputs,
  at: Date = new Date(),
): CommissionSnapshot {
  if (!config.isEnabled || config.commissionRatePct <= 0) {
    return {
      configId: config.configId,
      familyId: config.familyId,
      version: config.version,
      scopeId: config.scopeId,
      scopeLevel: config.scopeLevel,
      commissionRatePct: config.commissionRatePct,
      isEnabled: config.isEnabled,
      baseRule: config.baseRule,
      includeSurge: config.includeSurge,
      includeWaiting: config.includeWaiting,
      includeBookingFee: config.includeBookingFee,
      applyMinimumFloor: config.applyMinimumFloor,
      roundOffRupee: config.roundOffRupee,
      calculationBaseAmount: 0,
      commissionAmount: 0,
      capturedAt: at.toISOString(),
    };
  }

  let base = fare.baseFare + fare.distanceFare + fare.timeFare;
  if (config.includeSurge) base += fare.surgeAmount;
  if (config.applyMinimumFloor && fare.minimumFare > 0) {
    base = Math.max(base, fare.minimumFare);
  }
  if (config.includeWaiting || config.baseRule === 'PRE_TAX_TOTAL') {
    base += fare.waitingCharge;
  }
  if (config.includeBookingFee || config.baseRule === 'PRE_TAX_TOTAL') {
    base += fare.bookingFee;
  }
  if (config.baseRule === 'RIDE_SUBTOTAL_AFTER_DISCOUNT') {
    base = Math.max(0, base - fare.discountAmount);
  }

  const calculationBaseAmount = round2(base);
  const rawCommission = (calculationBaseAmount * config.commissionRatePct) / 100;
  const commissionAmount = config.roundOffRupee ? Math.round(rawCommission) : round2(rawCommission);

  return {
    configId: config.configId,
    familyId: config.familyId,
    version: config.version,
    scopeId: config.scopeId,
    scopeLevel: config.scopeLevel,
    commissionRatePct: config.commissionRatePct,
    isEnabled: config.isEnabled,
    baseRule: config.baseRule,
    includeSurge: config.includeSurge,
    includeWaiting: config.includeWaiting,
    includeBookingFee: config.includeBookingFee,
    applyMinimumFloor: config.applyMinimumFloor,
    roundOffRupee: config.roundOffRupee,
    calculationBaseAmount,
    commissionAmount,
    capturedAt: at.toISOString(),
  };
}

export class CommissionService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly featureFlagService: FeatureFlagReader,
  ) {}

  async isDbConfigSourceEnabled(): Promise<boolean> {
    return this.featureFlagService.isEnabledReadOnly(
      REV5_PRICING_FLAGS.COMMISSION_CONFIG_SOURCE,
    );
  }

  async isWalletDeductionEnabled(): Promise<boolean> {
    return this.featureFlagService.isEnabledReadOnly(
      REV5_PRICING_FLAGS.COMMISSION_WALLET_DEDUCTION,
    );
  }

  /// Resolves the single authoritative commission configuration for the requested scope
  /// using 6-tier deterministic precedence. Fails closed (503) if no enforced scope exists.
  async resolve(
    ctx: {
      cityCode?: string | null;
      serviceZoneId?: string | null;
      vehicleTypeId?: string | null;
      at?: Date;
    },
    tx?: TransactionClient,
  ): Promise<ResolvedCommissionConfig> {
    const at = ctx.at ?? new Date();
    const client = tx ?? this.databaseService.client;
    const candidates = buildScopeLookupCandidates(ctx);

    const rows = await client.commissionConfigurationScope.findMany({
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
      throw new CommissionConfigMissingError(
        `city=${ctx.cityCode ?? 'GLOBAL'}, zone=${ctx.serviceZoneId ?? 'NONE'}, vehicle=${ctx.vehicleTypeId ?? 'ALL'}`,
      );
    }

    const cfg = winner.config;
    const baseRule: CommissionBaseRule =
      cfg.baseRule === 'RIDE_SUBTOTAL_AFTER_DISCOUNT' || cfg.baseRule === 'PRE_TAX_TOTAL'
        ? cfg.baseRule
        : 'RIDE_SUBTOTAL_BEFORE_DISCOUNT';

    return {
      configId: cfg.id,
      familyId: cfg.familyId,
      version: cfg.version,
      scopeId: winner.id,
      scopeLevel: winner.scopeLevel,
      cityCode: winner.cityCode,
      serviceZoneId: winner.serviceZoneId,
      vehicleTypeId: winner.vehicleTypeId,
      commissionRatePct: Number(cfg.commissionRatePct.toString()),
      isEnabled: cfg.isEnabled,
      baseRule,
      includeSurge: cfg.includeSurge,
      includeWaiting: cfg.includeWaiting,
      includeBookingFee: cfg.includeBookingFee,
      applyMinimumFloor: cfg.applyMinimumFloor,
      roundOffRupee: cfg.roundOffRupee,
    };
  }
}
