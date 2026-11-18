import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import {
  FlagDependencyActiveError,
  FlagDependencyUnsatisfiedError,
  NonRecoveryGstContraUnapprovedError,
  REV5_PRICING_FLAGS,
  SCOPE_GLOBAL_CITY,
  SCOPE_NIL_UUID,
} from '../constants.js';

export type NonRecoveryGstMode =
  | 'UNAPPROVED'
  | 'DRIVER_LIABLE_INFORMATIONAL'
  | 'ZAROORAT_CONTRA_ACCOUNT';

export const NON_RECOVERY_GST_MODE_SETTING_KEY = 'pricing.non_recovery_gst_mode' as const;
export const NON_RECOVERY_GST_CONTRA_ACCOUNT_SETTING_KEY =
  'pricing.non_recovery_gst_contra_account' as const;

export interface FlagStateMap {
  [key: string]: boolean;
}

/// Rev 5 §1.3 & §1.4: Validates feature-flag dependency safety both at boot/readiness
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

    if (rawMode === 'DRIVER_LIABLE_INFORMATIONAL') {
      return { mode: 'DRIVER_LIABLE_INFORMATIONAL', contraAccount: null };
    }
    if (rawMode === 'ZAROORAT_CONTRA_ACCOUNT' && rawContra.length > 0) {
      return { mode: 'ZAROORAT_CONTRA_ACCOUNT', contraAccount: rawContra };
    }
    return { mode: 'UNAPPROVED', contraAccount: null };
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

    // 4. Passenger GST requires snapshot_read + CA-approved PASSENGER_RIDE_GST scope + legal entity + registrations
    //    AND if gst_recovery_enabled is OFF (Mode B), requires Finance/CA-approved D-20 non-recovery mode!
    if (isOn(REV5_PRICING_FLAGS.PASSENGER_GST_ENABLED)) {
      if (!isOn(REV5_PRICING_FLAGS.SNAPSHOT_READ)) {
        throw new FlagDependencyUnsatisfiedError(
          'pricing.passenger_gst_enabled requires pricing.snapshot_read to be ON.',
        );
      }

      const activeTaxScope = await client.taxConfigurationScope.findFirst({
        where: {
          taxKind: 'PASSENGER_RIDE_GST',
          isEnforced: true,
          effectiveFrom: { lte: now },
          OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
          config: {
            sacCode: { not: null },
            waitingTaxable: { not: null },
            legalReference: { not: null },
          },
        },
      });
      if (!activeTaxScope) {
        throw new FlagDependencyUnsatisfiedError(
          'pricing.passenger_gst_enabled requires at least one enforced CA-approved PASSENGER_RIDE_GST configuration with sac_code, waiting_taxable, and legal_reference.',
        );
      }

      // Check active cities have city_supply_registrations + state_code
      const activeCities = await client.city.findMany({ where: { isActive: true } });
      for (const city of activeCities) {
        if (!city.stateCode || city.stateCode.trim().length !== 2) {
          throw new FlagDependencyUnsatisfiedError(
            `pricing.passenger_gst_enabled requires 2-digit state_code on active city '${city.code}'.`,
          );
        }
        const reg = await client.citySupplyRegistration.findFirst({
          where: {
            cityCode: city.code,
            supplyKind: 'PASSENGER_RIDE',
            isActive: true,
            effectiveFrom: { lte: now },
            OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
            legalEntity: { isActive: true },
            gstRegistration: { isActive: true },
          },
        });
        if (!reg) {
          throw new FlagDependencyUnsatisfiedError(
            `pricing.passenger_gst_enabled requires an active city_supply_registrations mapping for active city '${city.code}'.`,
          );
        }
      }

      // Rev 5 R5-1: Mode B (passenger_gst_enabled = ON, gst_recovery_enabled = OFF)
      if (!isOn(REV5_PRICING_FLAGS.GST_RECOVERY_ENABLED)) {
        const d20 = await this.readNonRecoveryGstMode(tx);
        if (d20.mode === 'UNAPPROVED') {
          throw new NonRecoveryGstContraUnapprovedError(
            'Mode B (passenger_gst_enabled=ON with gst_recovery_enabled=OFF) is blocked until Finance/CA Decision D-20 non-recovery GST mode/contra account is configured.',
          );
        }
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
