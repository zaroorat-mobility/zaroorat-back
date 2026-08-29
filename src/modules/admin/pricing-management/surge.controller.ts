import type { FastifyReply, FastifyRequest } from 'fastify';
import { callerId } from '@core/auth';
import {
  createSurgeZoneSchema,
  updateSurgeZoneSchema,
  createSurgeWindowSchema,
  updateSurgeWindowSchema,
} from './surge.schema.js';
import { AdminSurgeService } from './surge.service.js';

export class AdminSurgeController {
  constructor(private readonly adminSurgeService: AdminSurgeService) {}

  async createSurgeZone(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const data = createSurgeZoneSchema.parse(req.body);
    const zone = await this.adminSurgeService.createSurgeZone(data, callerId(req));
    return reply.status(201).send(zone);
  }

  async listSurgeZones(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const zones = await this.adminSurgeService.listSurgeZones();
    return reply.send(zones);
  }

  async getSurgeZone(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = req.params as { id: string };
    const zone = await this.adminSurgeService.getSurgeZone(id);
    if (!zone) return reply.status(404).send({ error: 'Zone not found' });
    return reply.send(zone);
  }

  async updateSurgeZone(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = req.params as { id: string };
    const data = updateSurgeZoneSchema.parse(req.body);
    await this.adminSurgeService.updateSurgeZone(id, data, callerId(req));
    return reply.send({ success: true });
  }

  async deleteSurgeZone(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = req.params as { id: string };
    await this.adminSurgeService.deleteSurgeZone(id, callerId(req));
    return reply.send({ success: true });
  }

  async createSurgeWindow(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const data = createSurgeWindowSchema.parse(req.body);
    const window = await this.adminSurgeService.createSurgeWindow(
      {
        ...data,
        startsAt: new Date(data.startsAt),
        endsAt: data.endsAt ? new Date(data.endsAt) : undefined,
      },
      callerId(req),
    );
    return reply.status(201).send(window);
  }

  async listSurgeWindows(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const windows = await this.adminSurgeService.listSurgeWindows();
    return reply.send(windows);
  }

  async getSurgeWindow(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = req.params as { id: string };
    const window = await this.adminSurgeService.getSurgeWindow(id);
    if (!window) return reply.status(404).send({ error: 'Window not found' });
    return reply.send(window);
  }

  async updateSurgeWindow(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = req.params as { id: string };
    const data = updateSurgeWindowSchema.parse(req.body);
    const window = await this.adminSurgeService.updateSurgeWindow(
      id,
      {
        ...data,
        startsAt: data.startsAt ? new Date(data.startsAt) : undefined,
        endsAt: data.endsAt ? new Date(data.endsAt) : undefined,
      },
      callerId(req),
    );
    return reply.send(window);
  }

  async deleteSurgeWindow(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = req.params as { id: string };
    await this.adminSurgeService.deleteSurgeWindow(id, callerId(req));
    return reply.send({ success: true });
  }
}
