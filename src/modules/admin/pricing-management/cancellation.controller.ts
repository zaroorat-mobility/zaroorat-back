import type { FastifyReply, FastifyRequest } from 'fastify';
import { AdminCancellationService } from './cancellation.service.js';
import {
  cancellationPolicyIdParamSchema,
  createCancellationPolicyBodySchema,
  listCancellationPoliciesQuerySchema,
  updateCancellationPolicyBodySchema,
} from './cancellation.schemas.js';

export class AdminCancellationController {
  constructor(private readonly adminCancellationService: AdminCancellationService) {}

  async list(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = listCancellationPoliciesQuerySchema.parse(req.query);
    const result = await this.adminCancellationService.list(query);
    reply.send(result);
  }

  async getById(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = cancellationPolicyIdParamSchema.parse(req.params);
    const data = await this.adminCancellationService.getById(id);
    reply.send({ data });
  }

  async create(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const body = createCancellationPolicyBodySchema.parse(req.body);
    const data = await this.adminCancellationService.create(body);
    reply.status(201).send({ data });
  }

  async update(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = cancellationPolicyIdParamSchema.parse(req.params);
    const body = updateCancellationPolicyBodySchema.parse(req.body ?? {});
    const data = await this.adminCancellationService.update(id, body);
    reply.send({ data });
  }

  async activate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = cancellationPolicyIdParamSchema.parse(req.params);
    const data = await this.adminCancellationService.activate(id);
    reply.send({ data });
  }

  async deactivate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = cancellationPolicyIdParamSchema.parse(req.params);
    const data = await this.adminCancellationService.deactivate(id);
    reply.send({ data });
  }

  async remove(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = cancellationPolicyIdParamSchema.parse(req.params);
    await this.adminCancellationService.remove(id);
    reply.send({ success: true });
  }
}
