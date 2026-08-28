import type { FastifyReply, FastifyRequest } from 'fastify';
import { callerId } from '@core/auth';
import { AdminFareService } from './fare.service.js';
import {
  createFareRuleBodySchema,
  fareRuleIdParamSchema,
  listFareRulesQuerySchema,
  updateFareRuleBodySchema,
} from './fare.schemas.js';

export class AdminFareController {
  constructor(private readonly adminFareService: AdminFareService) {}

  async list(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = listFareRulesQuerySchema.parse(req.query);
    const result = await this.adminFareService.list(query);
    reply.send(result);
  }

  async getById(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = fareRuleIdParamSchema.parse(req.params);
    const data = await this.adminFareService.getById(id);
    reply.send({ data });
  }

  async create(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const body = createFareRuleBodySchema.parse(req.body);
    const actorId = callerId(req);
    const data = await this.adminFareService.create(body, actorId);
    reply.status(201).send({ data });
  }

  async update(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = fareRuleIdParamSchema.parse(req.params);
    const body = updateFareRuleBodySchema.parse(req.body ?? {});
    const actorId = callerId(req);
    const data = await this.adminFareService.update(id, body, actorId);
    reply.send({ data });
  }

  async activate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = fareRuleIdParamSchema.parse(req.params);
    const data = await this.adminFareService.activate(id);
    reply.send({ data });
  }

  async deactivate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = fareRuleIdParamSchema.parse(req.params);
    const data = await this.adminFareService.deactivate(id);
    reply.send({ data });
  }

  async remove(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = fareRuleIdParamSchema.parse(req.params);
    await this.adminFareService.remove(id);
    reply.send({ success: true });
  }
}
