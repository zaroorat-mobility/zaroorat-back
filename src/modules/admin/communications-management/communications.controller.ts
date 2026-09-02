import type { FastifyReply, FastifyRequest } from 'fastify';
import { AdminCommunicationsHistoryService } from './history.service.js';
import { AdminCommunicationsPushService } from './push.service.js';
import { AdminCommunicationsTemplateService } from './template.service.js';
import {
  createTemplateBodySchema,
  deliveryHistoryQuerySchema,
  idParamSchema,
  listTemplatesQuerySchema,
  pushHistoryQuerySchema,
  schedulePushBodySchema,
  sendPushBodySchema,
  updateTemplateBodySchema,
} from './communications.schemas.js';

export class AdminCommunicationsController {
  constructor(
    private readonly adminCommunicationsTemplateService: AdminCommunicationsTemplateService,
    private readonly adminCommunicationsHistoryService: AdminCommunicationsHistoryService,
    private readonly adminCommunicationsPushService: AdminCommunicationsPushService,
  ) {}

  async listTemplates(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = listTemplatesQuerySchema.parse(req.query);
    reply.send(await this.adminCommunicationsTemplateService.list(query));
  }

  async createTemplate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const body = createTemplateBodySchema.parse(req.body);
    reply
      .status(201)
      .send({ data: await this.adminCommunicationsTemplateService.create(body, req.auth?.userId) });
  }

  async updateTemplate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = idParamSchema.parse(req.params);
    const body = updateTemplateBodySchema.parse(req.body ?? {});
    reply.send({
      data: await this.adminCommunicationsTemplateService.update(id, body, req.auth?.userId),
    });
  }

  async listHistory(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = deliveryHistoryQuerySchema.parse(req.query);
    reply.send(await this.adminCommunicationsHistoryService.listDeliveries(query));
  }

  async sendPush(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const body = sendPushBodySchema.parse(req.body);
    reply
      .status(201)
      .send({ data: await this.adminCommunicationsPushService.send(body, req.auth?.userId) });
  }

  async schedulePush(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const body = schedulePushBodySchema.parse(req.body);
    reply
      .status(201)
      .send({ data: await this.adminCommunicationsPushService.schedule(body, req.auth?.userId) });
  }

  async listPushHistory(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = pushHistoryQuerySchema.parse(req.query);
    reply.send(await this.adminCommunicationsPushService.listHistory(query));
  }

  async retryPush(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = idParamSchema.parse(req.params);
    reply.send({ data: await this.adminCommunicationsPushService.retry(id, req.auth?.userId) });
  }
}
