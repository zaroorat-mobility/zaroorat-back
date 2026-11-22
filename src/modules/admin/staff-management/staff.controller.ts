import type { FastifyReply, FastifyRequest } from 'fastify';
import { auditActor } from '../audit/index.js';
import { AdminStaffService } from './staff.service.js';
import {
  createStaffBodySchema,
  listStaffQuerySchema,
  staffIdParamSchema,
  updateStaffBodySchema,
} from './staff.schemas.js';

export class AdminStaffController {
  constructor(private readonly adminStaffService: AdminStaffService) {}

  async list(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = listStaffQuerySchema.parse(req.query);
    const result = await this.adminStaffService.list(query);
    reply.send(result);
  }

  async getById(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = staffIdParamSchema.parse(req.params);
    const user = await this.adminStaffService.getById(id);
    reply.send({ data: user });
  }

  async create(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const body = createStaffBodySchema.parse(req.body);
    const user = await this.adminStaffService.create(body, auditActor(req));
    reply.status(201).send({ data: user });
  }

  async update(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = staffIdParamSchema.parse(req.params);
    const body = updateStaffBodySchema.parse(req.body);
    const user = await this.adminStaffService.update(id, body, auditActor(req));
    reply.send({ data: user });
  }

  async remove(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = staffIdParamSchema.parse(req.params);
    await this.adminStaffService.remove(id, auditActor(req));
    reply.status(204).send();
  }
}
