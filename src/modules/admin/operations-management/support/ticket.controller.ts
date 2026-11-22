import type { FastifyReply, FastifyRequest } from 'fastify';
import { callerId } from '@core/auth';
import { AdminTicketService } from './ticket.service.js';
import {
  listSupportTicketsQuerySchema,
  ticketIdParamSchema,
  createSupportTicketBodySchema,
  assignTicketBodySchema,
  updateTicketStatusBodySchema,
  addTicketMessageBodySchema,
  resolveTicketBodySchema,
} from './ticket.schemas.js';

export class AdminTicketController {
  constructor(private readonly adminTicketService: AdminTicketService) {}

  async list(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = listSupportTicketsQuerySchema.parse(req.query);
    const result = await this.adminTicketService.list(query);
    reply.send(result);
  }

  async getById(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = ticketIdParamSchema.parse(req.params);
    const ticket = await this.adminTicketService.getById(id);
    reply.send({ data: ticket });
  }

  async create(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const body = createSupportTicketBodySchema.parse(req.body);
    const actorId = callerId(req);
    const ticket = await this.adminTicketService.create(body, actorId);
    reply.status(201).send({ data: ticket });
  }

  async assign(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = ticketIdParamSchema.parse(req.params);
    const body = assignTicketBodySchema.parse(req.body);
    const actorId = callerId(req);
    const ticket = await this.adminTicketService.assign(id, body, actorId);
    reply.send({ data: ticket });
  }

  async updateStatus(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = ticketIdParamSchema.parse(req.params);
    const body = updateTicketStatusBodySchema.parse(req.body);
    const actorId = callerId(req);
    const ticket = await this.adminTicketService.updateStatus(id, body, actorId);
    reply.send({ data: ticket });
  }

  async addMessage(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = ticketIdParamSchema.parse(req.params);
    const body = addTicketMessageBodySchema.parse(req.body);
    const actorId = callerId(req);
    const ticket = await this.adminTicketService.addMessage(id, body, actorId);
    reply.status(201).send({ data: ticket });
  }

  async resolve(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = ticketIdParamSchema.parse(req.params);
    const body = resolveTicketBodySchema.parse(req.body);
    const actorId = callerId(req);
    const ticket = await this.adminTicketService.resolve(id, body, actorId);
    reply.send({ data: ticket });
  }

  async listCategories(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const categories = await this.adminTicketService.listCategories();
    reply.send({ data: categories });
  }

  async listAgents(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const agents = await this.adminTicketService.listAgents();
    reply.send({ data: agents });
  }
}
