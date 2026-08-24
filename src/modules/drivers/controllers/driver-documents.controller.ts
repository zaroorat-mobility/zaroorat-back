import type { FastifyReply, FastifyRequest } from 'fastify';
import { callerId } from '@core/auth';
import { DriverService } from '../services/driver.service.js';
import { DriverRepository } from '../repositories/driver.repository.js';
import {
  submitDriverDocumentSchema,
  reviewDriverDocumentSchema,
} from '../schemas/driver.schemas.js';
import { actingDriverId, authorizedDriverId } from './driver-identity.js';

export class DriverDocumentsController {
  constructor(
    private readonly driverService: DriverService,
    private readonly driverRepository: DriverRepository,
  ) {}

  async submitDocument(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const driverId = await actingDriverId(req, this.driverRepository);
    const body = submitDriverDocumentSchema.parse(req.body);
    const doc = await this.driverService.documents.submitDocument(
      {
        driverId,
        documentType: body.documentType,
        fileId: body.fileId,
        ...(body.documentNumber !== undefined ? { documentNumber: body.documentNumber } : {}),
        ...(body.expiresAt !== undefined ? { expiresAt: new Date(body.expiresAt) } : {}),
      },
      req.id,
    );
    reply.code(201).send({ data: doc });
  }

  async reviewDocument(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { driverId: requestedDriverId, documentId } = req.params as {
      driverId: string;
      documentId: string;
    };
    const driverId = await authorizedDriverId(req, this.driverRepository, requestedDriverId);
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
      '[drivers] document review decision recorded',
    );

    reply.send({ data: doc });
  }
}
