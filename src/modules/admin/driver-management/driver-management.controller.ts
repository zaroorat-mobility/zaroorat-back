import type { FastifyReply, FastifyRequest } from 'fastify';
import { callerId } from '@core/auth';
import { DriverService } from '@modules/drivers/services/driver.service.js';
import {
  reviewDriverDocumentSchema,
  reviewVerificationSchema,
} from '@modules/drivers/schemas/driver.schemas.js';

export class AdminDriverManagementController {
  constructor(private readonly driverService: DriverService) {}

  async reviewDocument(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { driverId, documentId } = req.params as {
      driverId: string;
      documentId: string;
    };
    const reviewerId = callerId(req);
    const body = reviewDriverDocumentSchema.parse(req.body);

    const doc = await this.driverService.onboarding.reviewDocument(
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
    const { id } = req.params as { id: string };
    const { isSuspended } = req.body as { isSuspended: boolean };

    await this.driverService.status.setSuspended(id, isSuspended);

    req.log.warn(
      { driverId: id, isSuspended, actorUserId: callerId(req) },
      '[admin-drivers] suspension state changed by operator',
    );
    reply.send({ data: { success: true } });
  }
}
