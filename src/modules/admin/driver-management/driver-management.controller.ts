import type { FastifyReply, FastifyRequest } from 'fastify';
import { callerId } from '@core/auth';
import { DriverService } from '@modules/drivers/services/driver.service.js';
import {
  reviewDriverDocumentSchema,
  reviewVerificationSchema,
} from '@modules/drivers/schemas/driver.schemas.js';
import { AdminDriverService } from './drivers/driver.service.js';
import { AdminApplicationService } from './applications/application.service.js';
import {
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
    const actorId = callerId(req);
    const application = await this.adminApplicationService.approve(id, actorId, body.notes);
    req.log.info(
      { applicationId: id, actorUserId: actorId },
      '[admin-applications] application approved',
    );
    reply.send({ data: application });
  }

  async rejectApplication(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = applicationIdParamSchema.parse(req.params);
    const body = applicationNotesBodySchema.parse(req.body ?? {});
    const actorId = callerId(req);
    const application = await this.adminApplicationService.reject(id, actorId, body.notes);
    req.log.info(
      { applicationId: id, actorUserId: actorId },
      '[admin-applications] application rejected',
    );
    reply.send({ data: application });
  }

  async requestApplicationResubmission(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = applicationIdParamSchema.parse(req.params);
    const body = applicationNotesBodySchema.parse(req.body ?? {});
    const actorId = callerId(req);
    const application = await this.adminApplicationService.requestResubmission(
      id,
      actorId,
      body.notes,
    );
    req.log.info(
      { applicationId: id, actorUserId: actorId },
      '[admin-applications] resubmission requested',
    );
    reply.send({ data: application });
  }

  async reviewApplicationDocument(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id, documentId } = applicationDocumentParamSchema.parse(req.params);
    const body = reviewDriverDocumentSchema.parse(req.body);
    const actorId = callerId(req);
    const application = await this.adminApplicationService.reviewDocument(
      id,
      documentId,
      body.status,
      actorId,
      body.rejectionReason,
    );
    reply.send({ data: application });
  }

  async reviewDocument(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { driverId, documentId } = req.params as {
      driverId: string;
      documentId: string;
    };
    const reviewerId = callerId(req);
    const body = reviewDriverDocumentSchema.parse(req.body);

    const doc = await this.driverService.documents.reviewDocument(
      documentId,
      driverId,
      body.status,
      reviewerId,
      body.rejectionReason,
    );

    req.log.info(
      { documentId, driverId, status: body.status, reviewerUserId: reviewerId },
      '[admin-drivers] document review decision recorded',
    );
    reply.send({ data: doc });
  }

  async reviewVerification(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = req.params as { id: string };
    const approvedBy = callerId(req);
    const body = reviewVerificationSchema.parse(req.body);

    const driver = await this.driverService.onboarding.reviewDriverVerification(
      id,
      body.status,
      approvedBy,
      body.rejectionReason,
    );

    req.log.info(
      { driverId: id, status: body.status, reviewerUserId: approvedBy },
      '[admin-drivers] verification decision recorded',
    );
    reply.send({ data: driver });
  }

  async suspend(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = driverIdParamSchema.parse(req.params);
    const body = suspendDriverBodySchema.parse(req.body ?? {});
    const actorId = callerId(req);
    const driver =
      body.isSuspended === false
        ? await this.adminDriverService.activate(id, actorId, body.notes)
        : await this.adminDriverService.suspend(id, actorId, body.notes);

    req.log.warn(
      { driverId: id, isSuspended: body.isSuspended !== false, actorUserId: actorId },
      '[admin-drivers] suspension state changed by operator',
    );
    reply.send({ data: driver });
  }

  async block(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = driverIdParamSchema.parse(req.params);
    const body = suspendDriverBodySchema.parse(req.body ?? {});
    const actorId = callerId(req);
    const driver = await this.adminDriverService.block(id, actorId, body.notes);

    req.log.warn(
      { driverId: id, actorUserId: actorId },
      '[admin-drivers] driver blocked by operator',
    );
    reply.send({ data: driver });
  }

  async activate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = driverIdParamSchema.parse(req.params);
    const body = suspendDriverBodySchema.parse(req.body ?? {});
    const actorId = callerId(req);
    const driver = await this.adminDriverService.activate(id, actorId, body.notes);

    req.log.warn(
      { driverId: id, isSuspended: false, actorUserId: actorId },
      '[admin-drivers] driver reactivated by operator',
    );
    reply.send({ data: driver });
  }
}
