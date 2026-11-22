import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import {
  FlagDependencyActiveError,
  FlagDependencyUnsatisfiedError,
  REV5_PRICING_FLAGS,
  SCOPE_GLOBAL_CITY,
  SCOPE_NIL_UUID,
} from '../constants.js';

export type NonRecoveryGstMode =
  | 'DRIVER_LIABLE_INFORMATIONAL'
  | 'ZAROORAT_CONTRA_ACCOUNT';

export const NON_RECOVERY_GST_MODE_SETTING_KEY = 'pricing.non_recovery_gst_mode' as const;
export const NON_RECOVERY_GST_CONTRA_ACCOUNT_SETTING_KEY =
  'pricing.non_recovery_gst_contra_account' as const;

export interface FlagStateMap {
  [key: string]: boolean;
}

/// Validates feature-flag dependency safety both at boot/readiness
/// and atomically inside every admin feature-flag toggle transaction.
export class FeatureFlagDependencyValidator {
  constructor(private readonly databaseService: DatabaseService) {}

  async readNonRecoveryGstMode(tx?: TransactionClient): Promise<{
    mode: NonRecoveryGstMode;
    contraAccount: string | null;
  }> {
    const client = tx ?? this.databaseService.client;
    const settings = await client.systemSetting.findMany({
      where: {
        key: {
          in: [NON_RECOVERY_GST_MODE_SETTING_KEY, NON_RECOVERY_GST_CONTRA_ACCOUNT_SETTING_KEY],
        },
      },
    });
    const byKey = new Map(settings.map((s) => [s.key, s.value]));
    const rawMode = String(byKey.get(NON_RECOVERY_GST_MODE_SETTING_KEY) ?? '').trim();
    const rawContra = String(byKey.get(NON_RECOVERY_GST_CONTRA_ACCOUNT_SETTING_KEY) ?? '').trim();

    if (rawMode === 'ZAROORAT_CONTRA_ACCOUNT' && rawContra.length > 0) {
      return { mode: 'ZAROORAT_CONTRA_ACCOUNT', contraAccount: rawContra };
    }
    // Default Mode B (passenger GST ON, driver recovery OFF) to informational GST without touching recovery clearing.
    return { mode: 'DRIVER_LIABLE_INFORMATIONAL', contraAccount: null };
  }

  /// Validates a prospective complete flag state (after applying requested flag changes).
  /// Throws coded 409 errors if any hard dependency or Mode B D-20 rule is violated.
  async validateProspectiveState(
    nextFlags: FlagStateMap,
    previousFlags: FlagStateMap,
    tx?: TransactionClient,
  ): Promise<void> {
    const client = tx ?? this.databaseService.client;
    const now = new Date();

    const isOn = (key: string) => Boolean(nextFlags[key]);
    const wasOn = (key: string) => Boolean(previousFlags[key]);

    // 1. Guard disabling foundational flags while a dependent deduction flag remains ON
    if (
      wasOn(REV5_PRICING_FLAGS.WALLET_RESERVATION_ENABLED) &&
      !isOn(REV5_PRICING_FLAGS.WALLET_RESERVATION_ENABLED) &&
      (isOn(REV5_PRICING_FLAGS.COMMISSION_WALLET_DEDUCTION) ||
        isOn(REV5_PRICING_FLAGS.GST_RECOVERY_ENABLED))
    ) {
      throw new FlagDependencyActiveError(
        'Cannot disable pricing.wallet_reservation_enabled while commission_wallet_deduction or gst_recovery_enabled is ON.',
      );
    }

    if (
      wasOn(REV5_PRICING_FLAGS.SNAPSHOT_READ) &&
      !isOn(REV5_PRICING_FLAGS.SNAPSHOT_READ) &&
      (isOn(REV5_PRICING_FLAGS.COMMISSION_WALLET_DEDUCTION) ||
        isOn(REV5_PRICING_FLAGS.PASSENGER_GST_ENABLED) ||
        isOn(REV5_PRICING_FLAGS.GST_RECOVERY_ENABLED))
    ) {
      throw new FlagDependencyActiveError(
        'Cannot disable pricing.snapshot_read while financial deduction or GST flags are ON.',
      );
    }

    if (
      wasOn(REV5_PRICING_FLAGS.COMMISSION_CONFIG_SOURCE) &&
      !isOn(REV5_PRICING_FLAGS.COMMISSION_CONFIG_SOURCE) &&
      isOn(REV5_PRICING_FLAGS.COMMISSION_WALLET_DEDUCTION)
    ) {
      throw new FlagDependencyActiveError(
        'Cannot disable pricing.commission_config_source while pricing.commission_wallet_deduction is ON.',
      );
    }

    if (
      wasOn(REV5_PRICING_FLAGS.PASSENGER_GST_ENABLED) &&
      !isOn(REV5_PRICING_FLAGS.PASSENGER_GST_ENABLED) &&
      isOn(REV5_PRICING_FLAGS.GST_RECOVERY_ENABLED)
    ) {
      throw new FlagDependencyActiveError(
        'Cannot disable pricing.passenger_gst_enabled while pricing.gst_recovery_enabled is ON.',
      );
    }

    // 2. Commission DB config source requires >= 1 enforced GLOBAL baseline scope
    if (isOn(REV5_PRICING_FLAGS.COMMISSION_CONFIG_SOURCE)) {
      const globalScope = await client.commissionConfigurationScope.findFirst({
        where: {
          scopeLevel: 'GLOBAL',
          cityCode: SCOPE_GLOBAL_CITY,
          serviceZoneId: SCOPE_NIL_UUID,
          vehicleTypeId: SCOPE_NIL_UUID,
          isEnforced: true,
          effectiveFrom: { lte: now },
          OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
        },
      });
      if (!globalScope) {
        throw new FlagDependencyUnsatisfiedError(
          'pricing.commission_config_source requires at least one active enforced GLOBAL commission scope.',
        );
      }
    }

    // 3. Commission wallet deduction requires snapshot_read + commission_config_source + wallet_reservation_enabled
    if (isOn(REV5_PRICING_FLAGS.COMMISSION_WALLET_DEDUCTION)) {
      if (
        !isOn(REV5_PRICING_FLAGS.SNAPSHOT_READ) ||
        !isOn(REV5_PRICING_FLAGS.COMMISSION_CONFIG_SOURCE) ||
        !isOn(REV5_PRICING_FLAGS.WALLET_RESERVATION_ENABLED)
      ) {
        throw new FlagDependencyUnsatisfiedError(
          'pricing.commission_wallet_deduction requires pricing.snapshot_read, pricing.commission_config_source, and pricing.wallet_reservation_enabled to be ON.',
        );
      }
    }

    // 4. Passenger GST requires snapshot_read + an active PASSENGER_RIDE_GST scope + active company GST registration
    if (isOn(REV5_PRICING_FLAGS.PASSENGER_GST_ENABLED)) {
      if (!isOn(REV5_PRICING_FLAGS.SNAPSHOT_READ)) {
        throw new FlagDependencyUnsatisfiedError(
          'pricing.passenger_gst_enabled requires pricing.snapshot_read to be ON.',
        );
      }

      const [activeTaxScope, activeGstReg] = await Promise.all([
        client.taxConfigurationScope.findFirst({
          where: {
            taxKind: 'PASSENGER_RIDE_GST',
            isEnforced: true,
            effectiveFrom: { lte: now },
            OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
          },
          select: { id: true },
        }),
        client.companyGstRegistration.findFirst({
          where: {
            isActive: true,
            effectiveFrom: { lte: now },
            OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
            legalEntity: { isActive: true },
          },
          select: { id: true },
        }),
      ]);

      if (!activeTaxScope) {
        throw new FlagDependencyUnsatisfiedError(
          'pricing.passenger_gst_enabled requires at least one active Passenger Ride GST rate in GST & Taxation.',
        );
      }

      if (!activeGstReg) {
        throw new FlagDependencyUnsatisfiedError(
          'pricing.passenger_gst_enabled requires an active Company Legal Entity and GST Registration (GSTIN) in GST & Taxation.',
        );
      }
    }

    // 5. GST recovery requires passenger_gst_enabled + wallet_reservation_enabled + snapshot_read + enforced recovery scope
    if (isOn(REV5_PRICING_FLAGS.GST_RECOVERY_ENABLED)) {
      if (
        !isOn(REV5_PRICING_FLAGS.PASSENGER_GST_ENABLED) ||
        !isOn(REV5_PRICING_FLAGS.WALLET_RESERVATION_ENABLED) ||
        !isOn(REV5_PRICING_FLAGS.SNAPSHOT_READ)
      ) {
        throw new FlagDependencyUnsatisfiedError(
          'pricing.gst_recovery_enabled requires pricing.passenger_gst_enabled, pricing.wallet_reservation_enabled, and pricing.snapshot_read to be ON.',
        );
      }

      const activeRecoveryScope = await client.gstRecoveryConfigurationScope.findFirst({
        where: {
          isEnforced: true,
          effectiveFrom: { lte: now },
          OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
        },
      });
      if (!activeRecoveryScope) {
        throw new FlagDependencyUnsatisfiedError(
          'pricing.gst_recovery_enabled requires at least one active enforced gst_recovery_configurations scope.',
        );
      }
    }

    // 6. Phase 6 (M-09): Fiscal document issuance requires >=1 active GST registration and >=1 active document series
    if (isOn(REV5_PRICING_FLAGS.DOCUMENTS_ISSUE)) {
      const [activeGstReg, activeSeries] = await Promise.all([
        client.companyGstRegistration.findFirst({
          where: {
            isActive: true,
            effectiveFrom: { lte: now },
            OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
            legalEntity: { isActive: true },
          },
          select: { id: true },
        }),
        client.documentSeries.findFirst({
          where: { isActive: true },
          select: { id: true },
        }),
      ]);
      if (!activeGstReg || !activeSeries) {
        throw new FlagDependencyUnsatisfiedError(
          'documents.issue requires at least one active company_gst_registrations row and at least one active document_series.',
        );
      }
    }
  }
}
