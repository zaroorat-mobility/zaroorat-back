import type { FastifyReply, FastifyRequest } from 'fastify';
import { DriverService } from '../services/driver.service.js';
import { DriverRepository } from '../repositories/driver.repository.js';
import { submitDriverDocumentSchema } from '../schemas/driver.schemas.js';
import { actingDriverId } from './driver-identity.js';

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
}
