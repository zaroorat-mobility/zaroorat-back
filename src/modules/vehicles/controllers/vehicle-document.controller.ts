import type { FastifyReply, FastifyRequest } from 'fastify';
import { callerId, callerHasRole } from '@core/auth';
import { DriverRepository } from '@modules/drivers/repositories/driver.repository.js';
import { DriverNotFoundError } from '@modules/drivers/errors/driver.errors.js';
import { VehicleDocumentService } from '../services/vehicle-document.service.js';
import { submitVehicleDocumentSchema } from '../schemas/vehicle.schemas.js';

export class VehicleDocumentController {
  constructor(
    private readonly vehicleDocumentService: VehicleDocumentService,
    private readonly driverRepository: DriverRepository,
  ) {}

  private async actingDriverId(req: FastifyRequest): Promise<string> {
    const userId = callerId(req);
    const driver = await this.driverRepository.findByUserId(userId);
    if (!driver) throw new DriverNotFoundError(userId);
    return driver.id;
  }

  async submit(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const driverId = await this.actingDriverId(req);
    const { id } = req.params as { id: string };
    const body = submitVehicleDocumentSchema.parse(req.body);
    const document = await this.vehicleDocumentService.submitDocument(
      {
        vehicleId: id,
        driverId,
        ownerUserId: callerId(req),
        documentType: body.documentType,
        fileId: body.fileId,
        ...(body.documentNumber !== undefined ? { documentNumber: body.documentNumber } : {}),
        ...(body.issuedAt !== undefined ? { issuedAt: new Date(body.issuedAt) } : {}),
        ...(body.expiresAt !== undefined ? { expiresAt: new Date(body.expiresAt) } : {}),
      },
      req.id,
    );
    reply.code(201).send({ data: document });
  }

  /// Staff reviewing a vehicle need the document list without holding an
  /// assignment on it; everyone else must own the vehicle. Same split as
  /// `authorizedDriverId` in the drivers module.
  async list(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = req.params as { id: string };
    if (!callerHasRole(req, 'admin', 'support')) {
      await this.vehicleDocumentService.assertManageable(id, await this.actingDriverId(req));
    }
    reply.send({ data: await this.vehicleDocumentService.listDocuments(id) });
  }
}
