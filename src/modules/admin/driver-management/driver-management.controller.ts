import type { FastifyReply, FastifyRequest } from 'fastify';
import { callerId } from '@core/auth';
import { DatabaseService } from '@core/database';
import { DriverService } from '@modules/drivers/services/driver.service.js';
import {
  reviewDriverDocumentSchema,
  reviewVerificationSchema,
} from '@modules/drivers/schemas/driver.schemas.js';
import { auditActor } from '../audit/index.js';
import { AdminDriverService } from './drivers/driver.service.js';
import { AdminApplicationService } from './applications/application.service.js';
import { AdminBankAccountService } from './bank-accounts/bank-account.service.js';
import { VehicleVerificationService } from '@modules/vehicles/services/vehicle-verification.service.js';
import {
  bankAccountDriverParamSchema,
  bankAccountParamSchema,
  bankAccountReasonBodySchema,
  driverIdParamSchema,
  listDriversQuerySchema,
  suspendDriverBodySchema,
} from './drivers/driver.schemas.js';
import {
  applicationDocumentParamSchema,
  applicationIdParamSchema,
  applicationNotesBodySchema,
  createManualApplicationBodySchema,
  listApplicationsQuerySchema,
} from './applications/application.schemas.js';

export class AdminDriverManagementController {
  constructor(
    private readonly driverService: DriverService,
    private readonly adminDriverService: AdminDriverService,
    private readonly adminApplicationService: AdminApplicationService,
    private readonly adminBankAccountService: AdminBankAccountService,
    private readonly vehicleVerificationService: VehicleVerificationService,
    private readonly databaseService: DatabaseService,
  ) {}

  async list(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = listDriversQuerySchema.parse(req.query);
    const result = await this.adminDriverService.list(query);
    reply.send(result);
  }

  async getById(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = driverIdParamSchema.parse(req.params);
    const driver = await this.adminDriverService.getById(id);
    reply.send({ data: driver });
  }

  async listApplications(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = listApplicationsQuerySchema.parse(req.query);
    const result = await this.adminApplicationService.list(query);
    reply.send(result);
  }

  async createApplication(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const body = createManualApplicationBodySchema.parse(req.body);
    const actorId = callerId(req);
    const application = await this.adminApplicationService.create(body, actorId);
    req.log.info(
      { applicationId: application.id, actorUserId: actorId },
      '[admin-applications] manual application created',
    );
    reply.status(201).send({ data: application });
  }

  async getApplicationById(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = applicationIdParamSchema.parse(req.params);
    const application = await this.adminApplicationService.getById(id);
    reply.send({ data: application });
  }

  async approveApplication(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = applicationIdParamSchema.parse(req.params);
    const body = applicationNotesBodySchema.parse(req.body ?? {});
    const actor = auditActor(req);
    const application = await this.adminApplicationService.approve(id, actor, body.notes);
    req.log.info(
      { applicationId: id, actorUserId: actor.actorId },
      '[admin-applications] application approved',
    );
    reply.send({ data: application });
  }

  async rejectApplication(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = applicationIdParamSchema.parse(req.params);
    const body = applicationNotesBodySchema.parse(req.body ?? {});
    const actor = auditActor(req);
    const application = await this.adminApplicationService.reject(id, actor, body.notes);
    req.log.info(
      { applicationId: id, actorUserId: actor.actorId },
      '[admin-applications] application rejected',
    );
    reply.send({ data: application });
  }

  async requestApplicationResubmission(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = applicationIdParamSchema.parse(req.params);
    const body = applicationNotesBodySchema.parse(req.body ?? {});
    const actor = auditActor(req);
    const application = await this.adminApplicationService.requestResubmission(
      id,
      actor,
      body.notes,
    );
    req.log.info(
      { applicationId: id, actorUserId: actor.actorId },
      '[admin-applications] resubmission requested',
    );
    reply.send({ data: application });
  }

  async reviewApplicationDocument(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id, documentId } = applicationDocumentParamSchema.parse(req.params);
    const body = reviewDriverDocumentSchema.parse(req.body);
    const application = await this.adminApplicationService.reviewDocument(
      id,
      documentId,
      body.status,
      auditActor(req),
      body.rejectionReason,
    );
    reply.send({ data: application });
  }

  async reviewDocument(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { driverId, documentId } = req.params as {
      driverId: string;
      documentId: string;
    };
    const actor = auditActor(req);
    const body = reviewDriverDocumentSchema.parse(req.body);

    const driverDoc = await this.databaseService.client.driverDocument.findUnique({
      where: { id: documentId },
      select: { id: true, driverId: true },
    });

    if (driverDoc) {
      const doc = await this.driverService.documents.reviewDocument(
        documentId,
        driverId,
        body.status,
        actor,
        body.rejectionReason,
      );

      req.log.info(
        { documentId, driverId, status: body.status, reviewerUserId: actor.actorId },
        '[admin-drivers] driver document review decision recorded',
      );
      reply.send({ data: doc });
      return;
    }

    const vehicleDoc = await this.databaseService.client.vehicleDocument.findUnique({
      where: { id: documentId },
      select: { id: true, vehicleId: true },
    });

    if (vehicleDoc) {
      const doc = await this.vehicleVerificationService.reviewDocument(
        vehicleDoc.vehicleId,
        documentId,
        body.status,
        actor,
        body.rejectionReason,
      );

      req.log.info(
        { documentId, driverId, status: body.status, reviewerUserId: actor.actorId },
        '[admin-drivers] vehicle document review decision recorded',
      );
      reply.send({ data: doc });
      return;
    }

    const doc = await this.driverService.documents.reviewDocument(
      documentId,
      driverId,
      body.status,
      actor,
      body.rejectionReason,
    );

    req.log.info(
      { documentId, driverId, status: body.status, reviewerUserId: actor.actorId },
      '[admin-drivers] document review decision recorded',
    );
    reply.send({ data: doc });
  }

  async reviewVerification(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = req.params as { id: string };
    const actor = auditActor(req);
    const body = reviewVerificationSchema.parse(req.body);

    const driver = await this.driverService.onboarding.reviewDriverVerification(
      id,
      body.status,
      actor,
      body.rejectionReason,
    );

    req.log.info(
      { driverId: id, status: body.status, reviewerUserId: actor.actorId },
      '[admin-drivers] verification decision recorded',
    );
    reply.send({ data: driver });
  }

  async suspend(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = driverIdParamSchema.parse(req.params);
    const body = suspendDriverBodySchema.parse(req.body ?? {});
    const actor = auditActor(req);
    const driver =
      body.isSuspended === false
        ? await this.adminDriverService.activate(id, actor, body.notes)
        : await this.adminDriverService.suspend(id, actor, body.notes);

    req.log.warn(
      { driverId: id, isSuspended: body.isSuspended !== false, actorUserId: actor.actorId },
      '[admin-drivers] suspension state changed by operator',
    );
    reply.send({ data: driver });
  }

  async block(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = driverIdParamSchema.parse(req.params);
    const body = suspendDriverBodySchema.parse(req.body ?? {});
    const actor = auditActor(req);
    const driver = await this.adminDriverService.block(id, actor, body.notes);

    req.log.warn(
      { driverId: id, actorUserId: actor.actorId },
      '[admin-drivers] driver blocked by operator',
    );
    reply.send({ data: driver });
  }

  async activate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = driverIdParamSchema.parse(req.params);
    const body = suspendDriverBodySchema.parse(req.body ?? {});
    const actor = auditActor(req);
    const driver = await this.adminDriverService.activate(id, actor, body.notes);

    req.log.warn(
      { driverId: id, isSuspended: false, actorUserId: actor.actorId },
      '[admin-drivers] driver reactivated by operator',
    );
    reply.send({ data: driver });
  }

  // ─── Bank accounts (Phase 1 verification gate) ───────────────────────────
  async listBankAccounts(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { driverId } = bankAccountDriverParamSchema.parse(req.params);
    reply.send({ data: await this.adminBankAccountService.list(driverId) });
  }

  async verifyBankAccount(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { driverId, accountId } = bankAccountParamSchema.parse(req.params);
    reply.send({
      data: await this.adminBankAccountService.verify(driverId, accountId, callerId(req)),
    });
  }

  async rejectBankAccount(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { driverId, accountId } = bankAccountParamSchema.parse(req.params);
    const { reason } = bankAccountReasonBodySchema.parse(req.body);
    reply.send({
      data: await this.adminBankAccountService.reject(driverId, accountId, callerId(req), reason),
    });
  }

  async enableBankAccountPayouts(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { driverId, accountId } = bankAccountParamSchema.parse(req.params);
    reply.send({
      data: await this.adminBankAccountService.enablePayouts(driverId, accountId, callerId(req)),
    });
  }

  async disableBankAccountPayouts(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { driverId, accountId } = bankAccountParamSchema.parse(req.params);
    const { reason } = bankAccountReasonBodySchema.parse(req.body);
    reply.send({
      data: await this.adminBankAccountService.disablePayouts(
        driverId,
        accountId,
        callerId(req),
        reason,
      ),
    });
  }

  async deactivateBankAccount(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { driverId, accountId } = bankAccountParamSchema.parse(req.params);
    const { reason } = bankAccountReasonBodySchema.parse(req.body);
    reply.send({
      data: await this.adminBankAccountService.deactivate(
        driverId,
        accountId,
        callerId(req),
        reason,
      ),
    });
  }
}
