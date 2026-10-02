import type { FastifyReply, FastifyRequest } from 'fastify';
import { auditActor } from '../audit/index.js';
import { AdminRiderService } from './rider.service.js';
import {
  listRidersQuerySchema,
  riderIdParamSchema,
  riderStatusNotesBodySchema,
} from './rider.schemas.js';

export class AdminRiderController {
  constructor(private readonly adminRiderService: AdminRiderService) {}

  async list(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = listRidersQuerySchema.parse(req.query);
    const result = await this.adminRiderService.list(query);
    reply.send(result);
  }

  async getById(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = riderIdParamSchema.parse(req.params);
    const rider = await this.adminRiderService.getById(id);
    reply.send({ data: rider });
  }

  async suspend(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = riderIdParamSchema.parse(req.params);
    const body = riderStatusNotesBodySchema.parse(req.body ?? {});
    const rider = await this.adminRiderService.suspend(id, auditActor(req), body.notes);
    reply.send({ data: rider });
  }

  async block(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = riderIdParamSchema.parse(req.params);
    const body = riderStatusNotesBodySchema.parse(req.body ?? {});
    const rider = await this.adminRiderService.block(id, auditActor(req), body.notes);
    reply.send({ data: rider });
  }

  async activate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = riderIdParamSchema.parse(req.params);
    const body = riderStatusNotesBodySchema.parse(req.body ?? {});
    const rider = await this.adminRiderService.activate(id, auditActor(req), body.notes);
    reply.send({ data: rider });
  }
}
