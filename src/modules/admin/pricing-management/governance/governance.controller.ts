import type { FastifyReply, FastifyRequest } from 'fastify';
import { auditActor } from '../../audit/index.js';
import { SettlementFailureRecoveryService } from '@modules/payments/services/commission-wallet/settlement-failure-recovery.service.js';
import { PricingReconciliationService } from '@modules/payments/services/commission-wallet/pricing-reconciliation.service.js';
import { AdminPricingGovernanceService } from './governance.service.js';
import {
  createCitySupplyRegistrationSchema,
  createCommissionConfigSchema,
  createGstRecoveryConfigSchema,
  createGstRegistrationSchema,
  createLegalEntitySchema,
  createTaxConfigSchema,
  governanceScopeParamSchema,
  governanceIdParamSchema,
  listSettlementFailuresQuerySchema,
  updateLegalEntitySchema,
  waiveSettlementFailureBodySchema,
} from './governance.schemas.js';

export class AdminPricingGovernanceController {
  constructor(
    private readonly adminPricingGovernanceService: AdminPricingGovernanceService,
    private readonly settlementFailureRecoveryService: SettlementFailureRecoveryService,
    private readonly pricingReconciliationService: PricingReconciliationService,
  ) {}

  async getPricingSummary(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const data = await this.adminPricingGovernanceService.getPricingSummary();
    reply.send({ data });
  }

  // Commission configs
  async listCommissionConfigs(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const data = await this.adminPricingGovernanceService.listCommissionConfigs();
    reply.send({ data });
  }
  async createCommissionConfig(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const body = createCommissionConfigSchema.parse(req.body);
    const data = await this.adminPricingGovernanceService.createCommissionConfig(
      body,
      auditActor(req),
    );
    reply.status(201).send({ data });
  }
  async approveCommissionConfig(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = governanceIdParamSchema.parse(req.params);
    const data = await this.adminPricingGovernanceService.approveCommissionConfig(
      id,
      auditActor(req),
    );
    reply.send({ data });
  }
  async deactivateCommissionScope(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id, scopeId } = governanceScopeParamSchema.parse(req.params);
    const data = await this.adminPricingGovernanceService.deactivateCommissionScope(
      id,
      scopeId,
      auditActor(req),
    );
    reply.send({ data });
  }

  // Tax configs
  async listTaxConfigs(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const q = (req.query ?? {}) as { kind?: 'PASSENGER_RIDE_GST' | 'COMMISSION_GST' };
    const data = await this.adminPricingGovernanceService.listTaxConfigs(q.kind);
    reply.send({ data });
  }
  async createTaxConfig(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const body = createTaxConfigSchema.parse(req.body);
    const data = await this.adminPricingGovernanceService.createTaxConfig(body, auditActor(req));
    reply.status(201).send({ data });
  }
  async approveTaxConfig(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = governanceIdParamSchema.parse(req.params);
    const data = await this.adminPricingGovernanceService.approveTaxConfig(id, auditActor(req));
    reply.send({ data });
  }

  // GST recovery configs
  async listGstRecoveryConfigs(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const data = await this.adminPricingGovernanceService.listGstRecoveryConfigs();
    reply.send({ data });
  }
  async createGstRecoveryConfig(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const body = createGstRecoveryConfigSchema.parse(req.body);
    const data = await this.adminPricingGovernanceService.createGstRecoveryConfig(
      body,
      auditActor(req),
    );
    reply.status(201).send({ data });
  }
  async approveGstRecoveryConfig(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = governanceIdParamSchema.parse(req.params);
    const data = await this.adminPricingGovernanceService.approveGstRecoveryConfig(
      id,
      auditActor(req),
    );
    reply.send({ data });
  }

  // Legal entities & Multi-state GST registrations
  async listLegalEntities(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const data = await this.adminPricingGovernanceService.listLegalEntities();
    reply.send({ data });
  }
  async createLegalEntity(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const body = createLegalEntitySchema.parse(req.body);
    const data = await this.adminPricingGovernanceService.createLegalEntity(body, auditActor(req));
    reply.status(201).send({ data });
  }
  async updateLegalEntity(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = governanceIdParamSchema.parse(req.params);
    const body = updateLegalEntitySchema.parse(req.body ?? {});
    const data = await this.adminPricingGovernanceService.updateLegalEntity(
      id,
      body,
      auditActor(req),
    );
    reply.send({ data });
  }
  async createGstRegistration(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = governanceIdParamSchema.parse(req.params);
    const body = createGstRegistrationSchema.parse(req.body);
    const data = await this.adminPricingGovernanceService.createGstRegistration(
      id,
      body,
      auditActor(req),
    );
    reply.status(201).send({ data });
  }
  async listCitySupplyRegistrations(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const q = (req.query ?? {}) as { cityCode?: string };
    const data = await this.adminPricingGovernanceService.listCitySupplyRegistrations(q.cityCode);
    reply.send({ data });
  }
  async createCitySupplyRegistration(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const body = createCitySupplyRegistrationSchema.parse(req.body);
    const data = await this.adminPricingGovernanceService.createCitySupplyRegistration(
      body,
      auditActor(req),
    );
    reply.status(201).send({ data });
  }

  // Settlement failures worklist & atomic recovery (Rev 5 R5-6)
  async listSettlementFailures(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = listSettlementFailuresQuerySchema.parse(req.query);
    const result = await this.settlementFailureRecoveryService.listFailures({
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.kind !== undefined ? { kind: query.kind } : {}),
      ...(query.driverId !== undefined ? { driverId: query.driverId } : {}),
      page: query.page,
      limit: query.limit,
    });
    reply.send(result);
  }
  async recoverSettlementFailure(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = governanceIdParamSchema.parse(req.params);
    const data = await this.settlementFailureRecoveryService.recoverFailure(id, auditActor(req));
    reply.send({ data });
  }
  async waiveSettlementFailure(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = governanceIdParamSchema.parse(req.params);
    const body = waiveSettlementFailureBodySchema.parse(req.body);
    const data = await this.settlementFailureRecoveryService.waiveFailure(
      id,
      body.reason,
      auditActor(req),
    );
    reply.send({ data });
  }

  // Daily Reconciliation & Stale Reservation Sweeper (Rev 5 §4.4 & §4.6)
  async runDailyReconciliation(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const data = await this.pricingReconciliationService.runDailyInvariants();
    reply.send({ data });
  }
  async sweepStaleReservations(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const data = await this.pricingReconciliationService.sweepStaleReservations();
    reply.send({ data });
  }
}
