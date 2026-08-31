import type { FastifyReply, FastifyRequest } from 'fastify';
import { callerId } from '@core/auth';
import { AdminRideService } from './ride.service.js';
import {
  addRideNoteBodySchema,
  cancelRideBodySchema,
  exportAdminRidesQuerySchema,
  listAdminRidesQuerySchema,
  listRideAuditLogsQuerySchema,
  rideIdParamSchema,
} from './ride.schemas.js';

export class AdminRideController {
  constructor(private readonly adminRideService: AdminRideService) {}

  async list(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = listAdminRidesQuerySchema.parse(req.query);
    const result = await this.adminRideService.list(query);
    reply.send(result);
  }

  async getById(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = rideIdParamSchema.parse(req.params);
    const data = await this.adminRideService.getById(id);
    reply.send({ data });
  }

  async getTimeline(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = rideIdParamSchema.parse(req.params);
    const data = await this.adminRideService.getTimeline(id);
    reply.send({ data });
  }

  async getFareBreakdown(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = rideIdParamSchema.parse(req.params);
    const data = await this.adminRideService.getFareBreakdown(id);
    reply.send({ data });
  }

  async getPayments(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = rideIdParamSchema.parse(req.params);
    const data = await this.adminRideService.getPayments(id);
    reply.send({ data });
  }

  async getDriverLocation(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = rideIdParamSchema.parse(req.params);
    const data = await this.adminRideService.getDriverLocation(id);
    reply.send({ data });
  }

  async getRoute(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = rideIdParamSchema.parse(req.params);
    const data = await this.adminRideService.getRoute(id);
    reply.send({ data });
  }

  async exportCsv(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = exportAdminRidesQuerySchema.parse(req.query);
    const csv = await this.adminRideService.exportCsv(query);
    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="rides-export.csv"')
      .send(csv);
  }

  async listNotes(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = rideIdParamSchema.parse(req.params);
    const notes = await this.adminRideService.listNotes(id);
    reply.send({ data: notes });
  }

  async addNote(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = rideIdParamSchema.parse(req.params);
    const body = addRideNoteBodySchema.parse(req.body);
    const actorId = callerId(req);
    const note = await this.adminRideService.addNote(id, body, actorId);
    reply.status(201).send({ data: note });
  }

  async cancelRide(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = rideIdParamSchema.parse(req.params);
    const body = cancelRideBodySchema.parse(req.body);
    const actorId = callerId(req);
    const data = await this.adminRideService.cancelRide(id, body, actorId);
    reply.send({ data });
  }

  async getAuditLogs(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = rideIdParamSchema.parse(req.params);
    const query = listRideAuditLogsQuerySchema.parse(req.query);
    const result = await this.adminRideService.getAuditLogs(id, query);
    reply.send(result);
  }
}
