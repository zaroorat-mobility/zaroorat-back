import { randomUUID } from 'node:crypto';
import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import { recordAdminAction, type AuditActor } from '../../audit/index.js';
import {
  REV5_PRICING_FLAGS,
  SCOPE_GLOBAL_CITY,
  SCOPE_NIL_UUID,
  normalizeScopeTuple,
  scopeTupleKey,
  type FeatureFlagReader,
} from '@modules/pricing';
import { PricingAdminError } from '../pricing.errors.js';
import type {
  CreateCitySupplyRegistrationBody,
  CreateCommissionConfigBody,
  CreateGstRecoveryConfigBody,
  CreateGstRegistrationBody,
  CreateLegalEntityBody,
  CreateTaxConfigBody,
  UpdateLegalEntityBody,
} from './governance.schemas.js';

function windowsOverlap(aFrom: Date, aTo: Date | null, bFrom: Date, bTo: Date | null): boolean {
  const aEndsAfterBStarts = aTo === null || aTo.getTime() > bFrom.getTime();
  const bEndsAfterAStarts = bTo === null || bTo.getTime() > aFrom.getTime();
  return aEndsAfterBStarts && bEndsAfterAStarts;
}

function isPgExclusionViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; cause?: { code?: string }; meta?: { code?: string } };
  return (
    e.code === '23P01' ||
    e.cause?.code === '23P01' ||
    e.meta?.code === '23P01' ||
    (err instanceof Error && err.message.includes('23P01'))
  );
}

function dedupeScopes(
  scopes: ReadonlyArray<{
    cityCode?: string | null | undefined;
    serviceZoneId?: string | null | undefined;
    vehicleTypeId?: string | null | undefined;
  }>,
) {
  const seen = new Set<string>();
  const normalized = [];
  for (const raw of scopes) {
    const t = normalizeScopeTuple(raw);
    const key = scopeTupleKey(t);
    if (seen.has(key)) {
      throw new PricingAdminError(
        `Duplicate scope tuple in request: ${key}`,
        'DUPLICATE_CONFIG_SCOPE',
        400,
      );
    }
    seen.add(key);
    normalized.push(t);
  }
  return normalized;
}

/// Phase 4 (Rev 5 §2.2, §3.1, §3.2, §3.3):
/// Manages the 3 independent operational configurations (Commission, Tax, GST Recovery)
/// with Rev 5 R5-3 concurrency-safe per-scope activation that NEVER deactivates sibling scopes,
/// plus Multi-Entity / Multi-State Legal Jurisdiction and Live Pricing Summary.
export class AdminPricingGovernanceService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly featureFlagService: FeatureFlagReader,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // M-03: Commission Configurations
  // ═══════════════════════════════════════════════════════════════════════════

  async listCommissionConfigs() {
    const rows = await this.databaseService.client.commissionConfiguration.findMany({
      include: { scopes: { orderBy: { createdAt: 'asc' } } },
      orderBy: [{ createdAt: 'desc' }, { version: 'desc' }],
    });
    return rows.map((r) => ({
      ...r,
      commissionRatePct: Number(r.commissionRatePct.toString()),
    }));
  }

  async createCommissionConfig(body: CreateCommissionConfigBody, actor: AuditActor) {
    const scopes = dedupeScopes(body.scopes);
    const effectiveFrom = body.declaredEffectiveFrom
      ? new Date(body.declaredEffectiveFrom)
      : new Date();
    const effectiveTo = body.declaredEffectiveTo ? new Date(body.declaredEffectiveTo) : null;

    return this.databaseService.transactionManager.execute(async (tx) => {
      const created = await tx.commissionConfiguration.create({
        data: {
          familyId: randomUUID(),
          version: 1,
          status: 'PENDING_APPROVAL',
          commissionRatePct: body.commissionRatePct,
          isEnabled: body.isEnabled,
          baseRule: body.baseRule,
          includeSurge: body.includeSurge,
          includeWaiting: body.includeWaiting,
          includeBookingFee: body.includeBookingFee,
          applyMinimumFloor: body.applyMinimumFloor,
          roundOffRupee: body.roundOffRupee,
          applyTo: 'NEW_RIDES_ONLY',
          declaredEffectiveFrom: effectiveFrom,
          declaredEffectiveTo: effectiveTo,
          reason: body.reason ?? null,
          createdBy: actor.actorId,
          scopes: {
            create: scopes.map((s) => ({
              scopeLevel: s.scopeLevel,
              cityCode: s.cityCode,
              serviceZoneId: s.serviceZoneId,
              vehicleTypeId: s.vehicleTypeId,
              effectiveFrom,
              effectiveTo,
              isEnforced: false,
            })),
          },
        },
        include: { scopes: true },
      });

      await recordAdminAction(tx, {
        ...actor,
        action: 'CREATE',
        entityType: 'commission_configuration',
        entityId: created.id,
        summary: `Commission config (${body.commissionRatePct}%) created in PENDING_APPROVAL`,
        after: created,
        result: 'SUCCESS',
      });

      return { ...created, commissionRatePct: Number(created.commissionRatePct.toString()) };
    });
  }

  /// Rev 5 R5-3: Concurrency-safe per-scope activation preserving sibling scopes!
  async approveCommissionConfig(id: string, actor: AuditActor) {
    try {
      return await this.databaseService.transactionManager.execute(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('commission_configurations'))`;

        const config = await tx.commissionConfiguration.findUnique({
          where: { id },
          include: { scopes: true },
        });
        if (!config) {
          throw new PricingAdminError('Commission configuration not found', 'CONFIG_NOT_FOUND', 404);
        }
        if (config.status !== 'PENDING_APPROVAL') {
          throw new PricingAdminError(
            `Only PENDING_APPROVAL configs can be approved (current: ${config.status})`,
            'INVALID_CONFIG_STATUS',
            409,
          );
        }
        if (config.createdBy === actor.actorId) {
          throw new PricingAdminError(
            'Maker-checker policy: creator cannot approve their own configuration.',
            'MAKER_CHECKER_VIOLATION',
            403,
          );
        }

        const now = new Date();
        const touchedParentIds = new Set<string>();

        for (const incomingScope of config.scopes) {
          const incumbents = await tx.commissionConfigurationScope.findMany({
            where: {
              isEnforced: true,
              cityCode: incomingScope.cityCode,
              serviceZoneId: incomingScope.serviceZoneId,
              vehicleTypeId: incomingScope.vehicleTypeId,
              configId: { not: config.id },
            },
          });

          const overlapping = incumbents.filter((old) =>
            windowsOverlap(
              old.effectiveFrom,
              old.effectiveTo,
              incomingScope.effectiveFrom,
              incomingScope.effectiveTo,
            ),
          );

          for (const oldScope of overlapping) {
            if (oldScope.effectiveFrom.getTime() >= incomingScope.effectiveFrom.getTime()) {
              throw new PricingAdminError(
                `Scope (${incomingScope.cityCode}/${incomingScope.serviceZoneId}/${incomingScope.vehicleTypeId}) overlaps with config ${oldScope.configId}`,
                'CONFIG_SCOPE_OVERLAP',
                409,
              );
            }
            // Close ONLY this specific incumbent scope — sibling scopes on oldScope.configId stay OPEN!
            await tx.commissionConfigurationScope.update({
              where: { id: oldScope.id },
              data: {
                effectiveTo: incomingScope.effectiveFrom,
                supersededByScopeId: incomingScope.id,
                closedAt: now,
                closedBy: actor.actorId,
              },
            });
            touchedParentIds.add(oldScope.configId);
          }
        }

        // Recompute parent status for every touched incumbent config (PARTIALLY_SUPERSEDED vs RETIRED)
        for (const parentId of touchedParentIds) {
          await this.recomputeCommissionParentStatus(parentId, now, tx);
        }

        // Enforce all incoming scopes (GiST exclusion constraint guarantees zero race overlaps)
        await tx.commissionConfigurationScope.updateMany({
          where: { configId: config.id },
          data: { isEnforced: true },
        });

        const nextStatus =
          config.declaredEffectiveFrom.getTime() <= now.getTime() ? 'ACTIVE' : 'SCHEDULED';
        const approved = await tx.commissionConfiguration.update({
          where: { id: config.id },
          data: { status: nextStatus, approvedBy: actor.actorId, approvedAt: now },
          include: { scopes: true },
        });

        await recordAdminAction(tx, {
          ...actor,
          action: 'UPDATE',
          entityType: 'commission_configuration',
          entityId: approved.id,
          summary: `Commission config approved -> ${nextStatus}`,
          before: { status: config.status },
          after: approved,
          result: 'SUCCESS',
        });

        return { ...approved, commissionRatePct: Number(approved.commissionRatePct.toString()) };
      });
    } catch (err) {
      if (isPgExclusionViolation(err)) {
        throw new PricingAdminError(
          'Concurrent activation caused an overlapping commission scope.',
          'CONFIG_SCOPE_OVERLAP',
          409,
        );
      }
      throw err;
    }
  }

  async deactivateCommissionScope(configId: string, scopeId: string, actor: AuditActor) {
    return this.databaseService.transactionManager.execute(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('commission_configurations'))`;
      const scope = await tx.commissionConfigurationScope.findFirst({
        where: { id: scopeId, configId },
      });
      if (!scope) {
        throw new PricingAdminError('Commission scope not found', 'CONFIG_SCOPE_NOT_FOUND', 404);
      }

      const dbSourceOn = await this.featureFlagService.isEnabledReadOnly(
        REV5_PRICING_FLAGS.COMMISSION_CONFIG_SOURCE,
      );
      const now = new Date();
      if (
        dbSourceOn &&
        scope.scopeLevel === 'GLOBAL' &&
        scope.isEnforced
      ) {
        const otherGlobal = await tx.commissionConfigurationScope.count({
          where: {
            id: { not: scope.id },
            scopeLevel: 'GLOBAL',
            cityCode: SCOPE_GLOBAL_CITY,
            serviceZoneId: SCOPE_NIL_UUID,
            vehicleTypeId: SCOPE_NIL_UUID,
            isEnforced: true,
            effectiveFrom: { lte: now },
            OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
          },
        });
        if (otherGlobal === 0) {
          throw new PricingAdminError(
            'Cannot retire the last active GLOBAL commission baseline while pricing.commission_config_source is ON.',
            'LAST_ACTIVE_BASELINE',
            409,
          );
        }
      }

      const updatedScope = await tx.commissionConfigurationScope.update({
        where: { id: scope.id },
        data: { isEnforced: false, closedAt: now, closedBy: actor.actorId },
      });
      await this.recomputeCommissionParentStatus(configId, now, tx);

      await recordAdminAction(tx, {
        ...actor,
        action: 'UPDATE',
        entityType: 'commission_configuration_scope',
        entityId: scope.id,
        summary: `Commission scope (${scope.scopeLevel}) deactivated`,
        before: scope,
        after: updatedScope,
        result: 'SUCCESS',
      });
      return updatedScope;
    });
  }

  private async recomputeCommissionParentStatus(
    parentId: string,
    now: Date,
    tx: TransactionClient,
  ) {
    const remainingOpen = await tx.commissionConfigurationScope.count({
      where: {
        configId: parentId,
        isEnforced: true,
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
      },
    });
    await tx.commissionConfiguration.update({
      where: { id: parentId },
      data: { status: remainingOpen > 0 ? 'PARTIALLY_SUPERSEDED' : 'RETIRED' },
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // M-04a: Tax Configurations (No auto SAC 9964; Requires CA approval metadata)
  // ═══════════════════════════════════════════════════════════════════════════

  async listTaxConfigs(kind?: 'PASSENGER_RIDE_GST' | 'COMMISSION_GST') {
    const rows = await this.databaseService.client.taxConfiguration.findMany({
      where: kind ? { kind } : {},
      include: { scopes: { orderBy: { createdAt: 'asc' } } },
      orderBy: [{ createdAt: 'desc' }, { version: 'desc' }],
    });
    return rows.map((r) => ({ ...r, ratePct: Number(r.ratePct.toString()) }));
  }

  async createTaxConfig(body: CreateTaxConfigBody, actor: AuditActor) {
    const scopes = dedupeScopes(body.scopes);
    const effectiveFrom = body.declaredEffectiveFrom
      ? new Date(body.declaredEffectiveFrom)
      : new Date();
    const effectiveTo = body.declaredEffectiveTo ? new Date(body.declaredEffectiveTo) : null;

    return this.databaseService.transactionManager.execute(async (tx) => {
      const created = await tx.taxConfiguration.create({
        data: {
          familyId: randomUUID(),
          version: 1,
          kind: body.kind,
          status: 'PENDING_APPROVAL',
          ratePct: body.ratePct,
          isEnabled: body.isEnabled,
          inclusive: body.inclusive,
          waitingTaxable: body.waitingTaxable ?? null,
          sacCode: body.sacCode ?? null,
          legalReference: body.legalReference ?? null,
          applyTo: 'NEW_RIDES_ONLY',
          declaredEffectiveFrom: effectiveFrom,
          declaredEffectiveTo: effectiveTo,
          createdBy: actor.actorId,
          scopes: {
            create: scopes.map((s) => ({
              taxKind: body.kind,
              scopeLevel: s.scopeLevel,
              cityCode: s.cityCode,
              serviceZoneId: s.serviceZoneId,
              vehicleTypeId: s.vehicleTypeId,
              effectiveFrom,
              effectiveTo,
              isEnforced: false,
            })),
          },
        },
        include: { scopes: true },
      });

      await recordAdminAction(tx, {
        ...actor,
        action: 'CREATE',
        entityType: 'tax_configuration',
        entityId: created.id,
        summary: `Tax config (${body.kind} ${body.ratePct}%) created in PENDING_APPROVAL`,
        after: created,
        result: 'SUCCESS',
      });
      return { ...created, ratePct: Number(created.ratePct.toString()) };
    });
  }

  async approveTaxConfig(id: string, actor: AuditActor) {
    try {
      return await this.databaseService.transactionManager.execute(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('tax_configurations'))`;

        const config = await tx.taxConfiguration.findUnique({
          where: { id },
          include: { scopes: true },
        });
        if (!config) {
          throw new PricingAdminError('Tax configuration not found', 'CONFIG_NOT_FOUND', 404);
        }
        if (config.status !== 'PENDING_APPROVAL') {
          throw new PricingAdminError(
            `Only PENDING_APPROVAL tax configs can be approved (current: ${config.status})`,
            'INVALID_CONFIG_STATUS',
            409,
          );
        }
        if (config.createdBy === actor.actorId) {
          throw new PricingAdminError(
            'Maker-checker policy: creator cannot approve their own configuration.',
            'MAKER_CHECKER_VIOLATION',
            403,
          );
        }
        // Rev 5 §3.1: Explicit CA-approved SAC, waitingTaxable, and legalReference required!
        if (
          !config.sacCode ||
          config.sacCode.trim().length < 4 ||
          config.waitingTaxable === null ||
          !config.legalReference ||
          config.legalReference.trim().length < 3
        ) {
          throw new PricingAdminError(
            'Tax configuration approval requires CA-approved sacCode, waitingTaxable, and legalReference (no default SAC 9964).',
            'SAC_CLASSIFICATION_REQUIRED',
            400,
          );
        }

        const now = new Date();
        const touchedParentIds = new Set<string>();

        for (const incomingScope of config.scopes) {
          const incumbents = await tx.taxConfigurationScope.findMany({
            where: {
              taxKind: config.kind,
              isEnforced: true,
              cityCode: incomingScope.cityCode,
              serviceZoneId: incomingScope.serviceZoneId,
              vehicleTypeId: incomingScope.vehicleTypeId,
              configId: { not: config.id },
            },
          });

          const overlapping = incumbents.filter((old) =>
            windowsOverlap(
              old.effectiveFrom,
              old.effectiveTo,
              incomingScope.effectiveFrom,
              incomingScope.effectiveTo,
            ),
          );

          for (const oldScope of overlapping) {
            if (oldScope.effectiveFrom.getTime() >= incomingScope.effectiveFrom.getTime()) {
              throw new PricingAdminError(
                `Tax scope (${config.kind}/${incomingScope.cityCode}/${incomingScope.serviceZoneId}/${incomingScope.vehicleTypeId}) overlaps with config ${oldScope.configId}`,
                'CONFIG_SCOPE_OVERLAP',
                409,
              );
            }
            await tx.taxConfigurationScope.update({
              where: { id: oldScope.id },
              data: {
                effectiveTo: incomingScope.effectiveFrom,
                supersededByScopeId: incomingScope.id,
                closedAt: now,
                closedBy: actor.actorId,
              },
            });
            touchedParentIds.add(oldScope.configId);
          }
        }

        for (const parentId of touchedParentIds) {
          const remainingOpen = await tx.taxConfigurationScope.count({
            where: {
              configId: parentId,
              isEnforced: true,
              OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
            },
          });
          await tx.taxConfiguration.update({
            where: { id: parentId },
            data: { status: remainingOpen > 0 ? 'PARTIALLY_SUPERSEDED' : 'RETIRED' },
          });
        }

        await tx.taxConfigurationScope.updateMany({
          where: { configId: config.id },
          data: { isEnforced: true },
        });

        const nextStatus =
          config.declaredEffectiveFrom.getTime() <= now.getTime() ? 'ACTIVE' : 'SCHEDULED';
        const approved = await tx.taxConfiguration.update({
          where: { id: config.id },
          data: { status: nextStatus, approvedBy: actor.actorId, approvedAt: now },
          include: { scopes: true },
        });

        await recordAdminAction(tx, {
          ...actor,
          action: 'UPDATE',
          entityType: 'tax_configuration',
          entityId: approved.id,
          summary: `Tax config (${config.kind}) approved -> ${nextStatus}`,
          before: { status: config.status },
          after: approved,
          result: 'SUCCESS',
        });

        return { ...approved, ratePct: Number(approved.ratePct.toString()) };
      });
    } catch (err) {
      if (isPgExclusionViolation(err)) {
        throw new PricingAdminError(
          'Concurrent activation caused an overlapping tax scope.',
          'CONFIG_SCOPE_OVERLAP',
          409,
        );
      }
      throw err;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // M-04b: Independent Driver GST Wallet Recovery Configurations
  // ═══════════════════════════════════════════════════════════════════════════

  async listGstRecoveryConfigs() {
    const rows = await this.databaseService.client.gstRecoveryConfiguration.findMany({
      include: { scopes: { orderBy: { createdAt: 'asc' } } },
      orderBy: [{ createdAt: 'desc' }, { version: 'desc' }],
    });
    return rows.map((r) => ({ ...r, recoveryRatePct: Number(r.recoveryRatePct.toString()) }));
  }

  async createGstRecoveryConfig(body: CreateGstRecoveryConfigBody, actor: AuditActor) {
    const scopes = dedupeScopes(body.scopes);
    const effectiveFrom = body.declaredEffectiveFrom
      ? new Date(body.declaredEffectiveFrom)
      : new Date();
    const effectiveTo = body.declaredEffectiveTo ? new Date(body.declaredEffectiveTo) : null;

    return this.databaseService.transactionManager.execute(async (tx) => {
      const created = await tx.gstRecoveryConfiguration.create({
        data: {
          familyId: randomUUID(),
          version: 1,
          status: 'PENDING_APPROVAL',
          recoveryRatePct: body.recoveryRatePct,
          isEnabled: body.isEnabled,
          baseRule: body.baseRule,
          roundOffRupee: body.roundOffRupee,
          legalReference: body.legalReference ?? null,
          applyTo: 'NEW_RIDES_ONLY',
          declaredEffectiveFrom: effectiveFrom,
          declaredEffectiveTo: effectiveTo,
          createdBy: actor.actorId,
          scopes: {
            create: scopes.map((s) => ({
              scopeLevel: s.scopeLevel,
              cityCode: s.cityCode,
              serviceZoneId: s.serviceZoneId,
              vehicleTypeId: s.vehicleTypeId,
              effectiveFrom,
              effectiveTo,
              isEnforced: false,
            })),
          },
        },
        include: { scopes: true },
      });

      await recordAdminAction(tx, {
        ...actor,
        action: 'CREATE',
        entityType: 'gst_recovery_configuration',
        entityId: created.id,
        summary: `GST recovery config (${body.recoveryRatePct}%) created in PENDING_APPROVAL`,
        after: created,
        result: 'SUCCESS',
      });
      return { ...created, recoveryRatePct: Number(created.recoveryRatePct.toString()) };
    });
  }

  async approveGstRecoveryConfig(id: string, actor: AuditActor) {
    try {
      return await this.databaseService.transactionManager.execute(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('gst_recovery_configurations'))`;

        const config = await tx.gstRecoveryConfiguration.findUnique({
          where: { id },
          include: { scopes: true },
        });
        if (!config) {
          throw new PricingAdminError('GST recovery configuration not found', 'CONFIG_NOT_FOUND', 404);
        }
        if (config.status !== 'PENDING_APPROVAL') {
          throw new PricingAdminError(
            `Only PENDING_APPROVAL configs can be approved (current: ${config.status})`,
            'INVALID_CONFIG_STATUS',
            409,
          );
        }
        if (config.createdBy === actor.actorId) {
          throw new PricingAdminError(
            'Maker-checker policy: creator cannot approve their own configuration.',
            'MAKER_CHECKER_VIOLATION',
            403,
          );
        }

        const now = new Date();
        const touchedParentIds = new Set<string>();

        for (const incomingScope of config.scopes) {
          const incumbents = await tx.gstRecoveryConfigurationScope.findMany({
            where: {
              isEnforced: true,
              cityCode: incomingScope.cityCode,
              serviceZoneId: incomingScope.serviceZoneId,
              vehicleTypeId: incomingScope.vehicleTypeId,
              configId: { not: config.id },
            },
          });

          const overlapping = incumbents.filter((old) =>
            windowsOverlap(
              old.effectiveFrom,
              old.effectiveTo,
              incomingScope.effectiveFrom,
              incomingScope.effectiveTo,
            ),
          );

          for (const oldScope of overlapping) {
            if (oldScope.effectiveFrom.getTime() >= incomingScope.effectiveFrom.getTime()) {
              throw new PricingAdminError(
                `GST recovery scope (${incomingScope.cityCode}/${incomingScope.serviceZoneId}/${incomingScope.vehicleTypeId}) overlaps with config ${oldScope.configId}`,
                'CONFIG_SCOPE_OVERLAP',
                409,
              );
            }
            await tx.gstRecoveryConfigurationScope.update({
              where: { id: oldScope.id },
              data: {
                effectiveTo: incomingScope.effectiveFrom,
                supersededByScopeId: incomingScope.id,
                closedAt: now,
                closedBy: actor.actorId,
              },
            });
            touchedParentIds.add(oldScope.configId);
          }
        }

        for (const parentId of touchedParentIds) {
          const remainingOpen = await tx.gstRecoveryConfigurationScope.count({
            where: {
              configId: parentId,
              isEnforced: true,
              OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
            },
          });
          await tx.gstRecoveryConfiguration.update({
            where: { id: parentId },
            data: { status: remainingOpen > 0 ? 'PARTIALLY_SUPERSEDED' : 'RETIRED' },
          });
        }

        await tx.gstRecoveryConfigurationScope.updateMany({
          where: { configId: config.id },
          data: { isEnforced: true },
        });

        const nextStatus =
          config.declaredEffectiveFrom.getTime() <= now.getTime() ? 'ACTIVE' : 'SCHEDULED';
        const approved = await tx.gstRecoveryConfiguration.update({
          where: { id: config.id },
          data: { status: nextStatus, approvedBy: actor.actorId, approvedAt: now },
          include: { scopes: true },
        });

        await recordAdminAction(tx, {
          ...actor,
          action: 'UPDATE',
          entityType: 'gst_recovery_configuration',
          entityId: approved.id,
          summary: `GST recovery config approved -> ${nextStatus}`,
          before: { status: config.status },
          after: approved,
          result: 'SUCCESS',
        });

        return { ...approved, recoveryRatePct: Number(approved.recoveryRatePct.toString()) };
      });
    } catch (err) {
      if (isPgExclusionViolation(err)) {
        throw new PricingAdminError(
          'Concurrent activation caused an overlapping GST recovery scope.',
          'CONFIG_SCOPE_OVERLAP',
          409,
        );
      }
      throw err;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // M-04c: Multi-Entity & Multi-State Legal Jurisdiction
  // ═══════════════════════════════════════════════════════════════════════════

  async listLegalEntities() {
    return this.databaseService.client.legalEntity.findMany({
      include: { gstRegistrations: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createLegalEntity(body: CreateLegalEntityBody, actor: AuditActor) {
    return this.databaseService.transactionManager.execute(async (tx) => {
      const entity = await tx.legalEntity.create({
        data: {
          legalEntityName: body.legalEntityName,
          tradeName: body.tradeName ?? null,
          pan: body.pan,
          headOfficeAddress: body.headOfficeAddress,
          isActive: body.isActive,
          updatedBy: actor.actorId,
        },
      });
      await recordAdminAction(tx, {
        ...actor,
        action: 'CREATE',
        entityType: 'legal_entity',
        entityId: entity.id,
        summary: `Legal entity '${entity.legalEntityName}' created`,
        after: entity,
        result: 'SUCCESS',
      });
      return entity;
    });
  }

  async updateLegalEntity(id: string, body: UpdateLegalEntityBody, actor: AuditActor) {
    return this.databaseService.transactionManager.execute(async (tx) => {
      const before = await tx.legalEntity.findUnique({ where: { id } });
      if (!before) {
        throw new PricingAdminError('Legal entity not found', 'LEGAL_ENTITY_NOT_FOUND', 404);
      }
      const after = await tx.legalEntity.update({
        where: { id },
        data: {
          ...(body.legalEntityName !== undefined ? { legalEntityName: body.legalEntityName } : {}),
          ...(body.tradeName !== undefined ? { tradeName: body.tradeName } : {}),
          ...(body.pan !== undefined ? { pan: body.pan } : {}),
          ...(body.headOfficeAddress !== undefined
            ? { headOfficeAddress: body.headOfficeAddress }
            : {}),
          ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
          updatedBy: actor.actorId,
        },
      });
      await recordAdminAction(tx, {
        ...actor,
        action: 'UPDATE',
        entityType: 'legal_entity',
        entityId: after.id,
        summary: `Legal entity '${after.legalEntityName}' updated`,
        before,
        after,
        result: 'SUCCESS',
      });
      return after;
    });
  }

  async createGstRegistration(
    legalEntityId: string,
    body: CreateGstRegistrationBody,
    actor: AuditActor,
  ) {
    if (!body.gstin.startsWith(body.stateCode)) {
      throw new PricingAdminError(
        `GSTIN '${body.gstin}' prefix does not match stateCode '${body.stateCode}'.`,
        'GSTIN_STATE_MISMATCH',
        400,
      );
    }
    return this.databaseService.transactionManager.execute(async (tx) => {
      const entity = await tx.legalEntity.findUnique({ where: { id: legalEntityId } });
      if (!entity) {
        throw new PricingAdminError('Legal entity not found', 'LEGAL_ENTITY_NOT_FOUND', 404);
      }
      const reg = await tx.companyGstRegistration.create({
        data: {
          legalEntityId,
          gstin: body.gstin,
          stateCode: body.stateCode,
          stateName: body.stateName,
          registrationAddress: body.registrationAddress,
          effectiveFrom: body.effectiveFrom ? new Date(body.effectiveFrom) : new Date(),
          effectiveTo: body.effectiveTo ? new Date(body.effectiveTo) : null,
          isActive: body.isActive,
        },
      });
      await recordAdminAction(tx, {
        ...actor,
        action: 'CREATE',
        entityType: 'company_gst_registration',
        entityId: reg.id,
        summary: `GST registration ${reg.gstin} (${reg.stateCode}) added`,
        after: reg,
        result: 'SUCCESS',
      });
      return reg;
    });
  }

  async listCitySupplyRegistrations(cityCode?: string) {
    return this.databaseService.client.citySupplyRegistration.findMany({
      where: cityCode ? { cityCode } : {},
      include: { legalEntity: true, gstRegistration: true },
      orderBy: [{ cityCode: 'asc' }, { supplyKind: 'asc' }],
    });
  }

  async createCitySupplyRegistration(
    body: CreateCitySupplyRegistrationBody,
    actor: AuditActor,
  ) {
    try {
      return await this.databaseService.transactionManager.execute(async (tx) => {
        const reg = await tx.companyGstRegistration.findUnique({
          where: { id: body.gstRegistrationId },
        });
        if (!reg || reg.legalEntityId !== body.legalEntityId) {
          throw new PricingAdminError(
            'GST registration does not belong to the specified legal entity.',
            'GST_REGISTRATION_ENTITY_MISMATCH',
            400,
          );
        }
        const mapping = await tx.citySupplyRegistration.create({
          data: {
            cityCode: body.cityCode,
            supplyKind: body.supplyKind,
            legalEntityId: body.legalEntityId,
            gstRegistrationId: body.gstRegistrationId,
            effectiveFrom: body.effectiveFrom ? new Date(body.effectiveFrom) : new Date(),
            effectiveTo: body.effectiveTo ? new Date(body.effectiveTo) : null,
            isActive: body.isActive,
          },
          include: { legalEntity: true, gstRegistration: true },
        });
        await recordAdminAction(tx, {
          ...actor,
          action: 'CREATE',
          entityType: 'city_supply_registration',
          entityId: mapping.id,
          summary: `City supply registration mapped: ${body.cityCode} (${body.supplyKind}) -> ${reg.gstin}`,
          after: mapping,
          result: 'SUCCESS',
        });
        return mapping;
      });
    } catch (err) {
      if (isPgExclusionViolation(err)) {
        throw new PricingAdminError(
          `Active city supply registration already exists for ${body.cityCode} (${body.supplyKind}) in that window.`,
          'CITY_SUPPLY_OVERLAP',
          409,
        );
      }
      throw err;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Live Control Center Summary (Rev 5 §3.3 — Zero Mocks, Dynamically Computed Total)
  // ═══════════════════════════════════════════════════════════════════════════

  async getPricingSummary() {
    const client = this.databaseService.client;
    const now = new Date();

    const [
      activeFareRulesCount,
      activeSurgeWindowsCount,
      activeCancellationPoliciesCount,
      openSettlementFailuresCount,
      globalCommScope,
      globalTaxScope,
      globalRecoveryScope,
      commissionFlagOn,
      passengerGstFlagOn,
      gstRecoveryFlagOn,
      reservationFlagOn,
    ] = await Promise.all([
      client.pricingRule.count({ where: { isActive: true } }),
      client.surgeWindow.count({
        where: {
          isActive: true,
          startsAt: { lte: now },
          OR: [{ endsAt: null }, { endsAt: { gt: now } }],
        },
      }),
      client.cancellationPolicy.count({ where: { isActive: true } }),
      client.commissionCollectionFailure.count({ where: { status: 'OPEN' } }),
      client.commissionConfigurationScope.findFirst({
        where: {
          scopeLevel: 'GLOBAL',
          cityCode: SCOPE_GLOBAL_CITY,
          serviceZoneId: SCOPE_NIL_UUID,
          vehicleTypeId: SCOPE_NIL_UUID,
          isEnforced: true,
          effectiveFrom: { lte: now },
          OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
        },
        include: { config: true },
      }),
      client.taxConfigurationScope.findFirst({
        where: {
          taxKind: 'PASSENGER_RIDE_GST',
          scopeLevel: 'GLOBAL',
          cityCode: SCOPE_GLOBAL_CITY,
          serviceZoneId: SCOPE_NIL_UUID,
          vehicleTypeId: SCOPE_NIL_UUID,
          isEnforced: true,
          effectiveFrom: { lte: now },
          OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
        },
        include: { config: true },
      }),
      client.gstRecoveryConfigurationScope.findFirst({
        where: {
          scopeLevel: 'GLOBAL',
          cityCode: SCOPE_GLOBAL_CITY,
          serviceZoneId: SCOPE_NIL_UUID,
          vehicleTypeId: SCOPE_NIL_UUID,
          isEnforced: true,
          effectiveFrom: { lte: now },
          OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
        },
        include: { config: true },
      }),
      this.featureFlagService.isEnabledReadOnly(REV5_PRICING_FLAGS.COMMISSION_WALLET_DEDUCTION),
      this.featureFlagService.isEnabledReadOnly(REV5_PRICING_FLAGS.PASSENGER_GST_ENABLED),
      this.featureFlagService.isEnabledReadOnly(REV5_PRICING_FLAGS.GST_RECOVERY_ENABLED),
      this.featureFlagService.isEnabledReadOnly(REV5_PRICING_FLAGS.WALLET_RESERVATION_ENABLED),
    ]);

    const commissionPct = globalCommScope ? Number(globalCommScope.config.commissionRatePct) : null;
    const passengerGstPct = globalTaxScope ? Number(globalTaxScope.config.ratePct) : null;
    const gstRecoveryPct = globalRecoveryScope
      ? Number(globalRecoveryScope.config.recoveryRatePct)
      : null;

    // Dynamically computed combined rate — NEVER stored in DB!
    const combinedRatePct =
      commissionPct !== null || gstRecoveryPct !== null
        ? Math.round(((commissionPct ?? 0) + (gstRecoveryPct ?? 0)) * 100) / 100
        : null;

    return {
      counts: {
        activeFareRules: activeFareRulesCount,
        activeSurgeWindows: activeSurgeWindowsCount,
        activeCancellationPolicies: activeCancellationPoliciesCount,
        openSettlementFailures: openSettlementFailuresCount,
      },
      activeGlobalBaseline: {
        commission: globalCommScope
          ? {
              configId: globalCommScope.config.id,
              version: globalCommScope.config.version,
              ratePct: commissionPct,
              isEnabled: globalCommScope.config.isEnabled,
            }
          : null,
        passengerGst: globalTaxScope
          ? {
              configId: globalTaxScope.config.id,
              version: globalTaxScope.config.version,
              ratePct: passengerGstPct,
              sacCode: globalTaxScope.config.sacCode,
              waitingTaxable: globalTaxScope.config.waitingTaxable,
              isEnabled: globalTaxScope.config.isEnabled,
            }
          : null,
        gstRecovery: globalRecoveryScope
          ? {
              configId: globalRecoveryScope.config.id,
              version: globalRecoveryScope.config.version,
              ratePct: gstRecoveryPct,
              isEnabled: globalRecoveryScope.config.isEnabled,
            }
          : null,
        combinedDriverDeductionPct: combinedRatePct,
      },
      flags: {
        commissionWalletDeduction: commissionFlagOn,
        passengerGstEnabled: passengerGstFlagOn,
        gstRecoveryEnabled: gstRecoveryFlagOn,
        walletReservationEnabled: reservationFlagOn,
      },
    };
  }
}
