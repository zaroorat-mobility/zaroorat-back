import type { FastifyReply, FastifyRequest } from 'fastify';
import { callerId } from '@core/auth';
import { VehicleVerificationService } from '@modules/vehicles/services/vehicle-verification.service.js';
import { reviewVehicleSchema } from '@modules/vehicles/schemas/vehicle.schemas.js';
import { toVehicleView } from '@modules/vehicles/controllers/vehicle.controller.js';
import { AdminVehicleService } from './vehicle.service.js';
import {
  flagRenewalBodySchema,
  listVehiclesQuerySchema,
  vehicleIdParamSchema,
} from './vehicle.schemas.js';

export class AdminVehicleManagementController {
  constructor(
    private readonly vehicleVerificationService: VehicleVerificationService,
    private readonly adminVehicleService: AdminVehicleService,
  ) {}

  async list(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = listVehiclesQuerySchema.parse(req.query);
    const result = await this.adminVehicleService.list(query);
    reply.send(result);
  }

  async getById(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = vehicleIdParamSchema.parse(req.params);
    const vehicle = await this.adminVehicleService.getById(id);
    reply.send({ data: vehicle });
  }

  async flagForRenewal(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = vehicleIdParamSchema.parse(req.params);
    const body = flagRenewalBodySchema.parse(req.body ?? {});
    const actorId = callerId(req);
    const vehicle = await this.adminVehicleService.flagForRenewal(id, actorId, body.notes);
    req.log.warn(
      { vehicleId: id, actorUserId: actorId },
      '[admin-vehicles] vehicle flagged for renewal',
    );
    reply.send({ data: vehicle });
  }

  async getForReview(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = req.params as { id: string };
    const { vehicle, documents } = await this.vehicleVerificationService.getForReview(id);
    reply.send({ data: { vehicle: toVehicleView(vehicle), documents } });
  }

  async reviewDocument(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id, documentId } = req.params as { id: string; documentId: string };
    const body = reviewVehicleSchema.parse(req.body);
    const reviewerUserId = callerId(req);
    const document = await this.vehicleVerificationService.reviewDocument(
      id,
      documentId,
      body.status,
      reviewerUserId,
      body.rejectionReason,
    );
    req.log.info(
      { vehicleId: id, documentId, status: body.status, reviewerUserId },
      '[admin-vehicles] document review decision recorded',
    );
    reply.send({ data: document });
  }

  async reviewVehicle(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = req.params as { id: string };
    const body = reviewVehicleSchema.parse(req.body);
    const reviewerUserId = callerId(req);
    const vehicle = await this.vehicleVerificationService.reviewVehicle(
      id,
      body.status,
      reviewerUserId,
      body.rejectionReason,
    );
    req.log.warn(
      { vehicleId: id, status: body.status, reviewerUserId },
      '[admin-vehicles] verification decision recorded',
    );
    reply.send({ data: toVehicleView(vehicle) });
  }
}
