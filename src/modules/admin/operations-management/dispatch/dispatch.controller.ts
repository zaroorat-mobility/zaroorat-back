import { FastifyReply, FastifyRequest } from 'fastify';
import { AdminDispatchService } from './dispatch.service.js';
import {
  dispatchRequestIdParamSchema,
  listDispatchRequestsQuerySchema,
} from './dispatch.schemas.js';

export class AdminDispatchController {
  constructor(private readonly adminDispatchService: AdminDispatchService) {}

  async listRequests(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = listDispatchRequestsQuerySchema.parse(req.query);
    const result = await this.adminDispatchService.listRequests(query);
    reply.send(result);
  }

  async getRequestDetails(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const params = dispatchRequestIdParamSchema.parse(req.params);
    const result = await this.adminDispatchService.getRequestDetails(params.id);
    reply.send(result);
  }

  async getCandidates(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const params = dispatchRequestIdParamSchema.parse(req.params);
    const result = await this.adminDispatchService.getCandidates(params.id);
    reply.send(result);
  }
}
