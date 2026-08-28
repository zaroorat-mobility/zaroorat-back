import type { FastifyReply, FastifyRequest } from 'fastify';
import { AdminServiceZoneService } from './service-zone.service.js';
import { listServiceZonesQuerySchema } from './fare.schemas.js';

export class AdminServiceZoneController {
  constructor(private readonly adminServiceZoneService: AdminServiceZoneService) {}

  async list(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = listServiceZonesQuerySchema.parse(req.query);
    const data = await this.adminServiceZoneService.listByCityCode(query.cityCode);
    reply.send({ data });
  }
}
