import type { FastifyReply, FastifyRequest } from 'fastify';
import { callerId } from '@core/auth';
import { AdminSafetyService } from './incident.service.js';
import {
  listSafetyIncidentsQuerySchema,
  incidentIdParamSchema,
  createSafetyIncidentBodySchema,
  acknowledgeIncidentBodySchema,
  resolveIncidentBodySchema,
  escalateIncidentBodySchema,
  addIncidentNoteBodySchema,
  attachEvidenceBodySchema,
} from './incident.schemas.js';

export class AdminSafetyController {
  constructor(private readonly adminSafetyService: AdminSafetyService) {}

  async list(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = listSafetyIncidentsQuerySchema.parse(req.query);
    const result = await this.adminSafetyService.list(query);
    reply.send(result);
  }

  async getById(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = incidentIdParamSchema.parse(req.params);
    const incident = await this.adminSafetyService.getById(id);
    reply.send({ data: incident });
  }

  async create(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const body = createSafetyIncidentBodySchema.parse(req.body);
    const actorId = callerId(req);
    const incident = await this.adminSafetyService.create(body, actorId);
    reply.status(201).send({ data: incident });
  }

  async acknowledge(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = incidentIdParamSchema.parse(req.params);
    const body = acknowledgeIncidentBodySchema.parse(req.body);
    const actorId = callerId(req);
    const incident = await this.adminSafetyService.acknowledge(id, body, actorId);
    reply.send({ data: incident });
  }

  async resolve(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = incidentIdParamSchema.parse(req.params);
    const body = resolveIncidentBodySchema.parse(req.body);
    const actorId = callerId(req);
    const incident = await this.adminSafetyService.resolve(id, body, actorId);
    reply.send({ data: incident });
  }

  async escalate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = incidentIdParamSchema.parse(req.params);
    const body = escalateIncidentBodySchema.parse(req.body);
    const actorId = callerId(req);
    const incident = await this.adminSafetyService.escalate(id, body, actorId);
    reply.send({ data: incident });
  }

  async addNote(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = incidentIdParamSchema.parse(req.params);
    const body = addIncidentNoteBodySchema.parse(req.body);
    const actorId = callerId(req);
    const incident = await this.adminSafetyService.addNote(id, body, actorId);
    reply.send({ data: incident });
  }

  async attachEvidence(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = incidentIdParamSchema.parse(req.params);
    const body = attachEvidenceBodySchema.parse(req.body);
    const actorId = callerId(req);
    const incident = await this.adminSafetyService.attachEvidence(id, body, actorId);
    reply.send({ data: incident });
  }
}
