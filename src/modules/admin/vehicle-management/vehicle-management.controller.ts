import type { FastifyReply, FastifyRequest } from 'fastify';
import { callerId } from '@core/auth';
import { auditActor } from '../audit/index.js';
import { VehicleVerificationService } from '@modules/vehicles/services/vehicle-verification.service.js';
import { VehicleTypeService } from '@modules/vehicles/services/vehicle-type.service.js';
import { toVehicleTypeView } from '@modules/vehicles/controllers/vehicle-type.controller.js';
import { reviewVehicleSchema } from '@modules/vehicles/schemas/vehicle.schemas.js';
import { toVehicleView } from '@modules/vehicles/controllers/vehicle.controller.js';
import { AdminVehicleService } from './vehicle.service.js';
import {
  flagRenewalBodySchema,
  listVehiclesQuerySchema,
  vehicleIdParamSchema,
  createVehicleTypeBodySchema,
  updateVehicleTypeBodySchema,
  reorderVehicleTypesBodySchema,
} from './vehicle.schemas.js';

export class AdminVehicleManagementController {
  constructor(
    private readonly vehicleVerificationService: VehicleVerificationService,
    private readonly adminVehicleService: AdminVehicleService,
    private readonly vehicleTypeService: VehicleTypeService,
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
    const actor = auditActor(req);
    const document = await this.vehicleVerificationService.reviewDocument(
      id,
      documentId,
      body.status,
      actor,
      body.rejectionReason,
    );
    req.log.info(
      { vehicleId: id, documentId, status: body.status, reviewerUserId: actor.actorId },
      '[admin-vehicles] document review decision recorded',
    );
    reply.send({ data: document });
  }

  async reviewVehicle(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = req.params as { id: string };
    const body = reviewVehicleSchema.parse(req.body);
    const actor = auditActor(req);
    const vehicle = await this.vehicleVerificationService.reviewVehicle(
      id,
      body.status,
      actor,
      body.rejectionReason,
    );
    req.log.warn(
      { vehicleId: id, status: body.status, reviewerUserId: actor.actorId },
      '[admin-vehicles] verification decision recorded',
    );
    reply.send({ data: toVehicleView(vehicle) });
  }

  // ───── FLEET / SERVICE TYPES CATALOG MANAGEMENT ─────

  async listVehicleTypes(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const types = await this.vehicleTypeService.listAll(true);
    reply.send({ data: types.map((type) => toVehicleTypeView(type)) });
  }

  async createVehicleType(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const body = createVehicleTypeBodySchema.parse(req.body);
    const created = await this.vehicleTypeService.createVehicleType(body);
    req.log.info({ vehicleTypeId: created.id, code: created.code }, '[admin-vehicles] vehicle type created');
    reply.status(201).send({ data: toVehicleTypeView(created) });
  }

  async updateVehicleType(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = vehicleIdParamSchema.parse(req.params);
    const body = updateVehicleTypeBodySchema.parse(req.body);
    const updated = await this.vehicleTypeService.updateVehicleType(id, body as any);
    req.log.info({ vehicleTypeId: id }, '[admin-vehicles] vehicle type updated');
    reply.send({ data: toVehicleTypeView(updated) });
  }

  async toggleVehicleType(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = vehicleIdParamSchema.parse(req.params);
    const updated = await this.vehicleTypeService.toggleActive(id);
    req.log.info({ vehicleTypeId: id, isActive: updated.isActive }, '[admin-vehicles] vehicle type active status toggled');
    reply.send({ data: toVehicleTypeView(updated) });
  }

  async reorderVehicleTypes(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const body = reorderVehicleTypesBodySchema.parse(req.body);
    await this.vehicleTypeService.reorder(body.orderings);
    req.log.info({ count: body.orderings.length }, '[admin-vehicles] vehicle types reordered');
    reply.send({ success: true });
  }

  async deleteVehicleType(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = vehicleIdParamSchema.parse(req.params);
    await this.vehicleTypeService.deleteVehicleType(id);
    req.log.info({ vehicleTypeId: id }, '[admin-vehicles] vehicle type deleted');
    reply.status(200).send({ success: true });
  }
}
