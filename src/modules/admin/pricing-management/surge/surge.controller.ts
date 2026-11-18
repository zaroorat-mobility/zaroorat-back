import type { FastifyReply, FastifyRequest } from 'fastify';
import { callerId } from '@core/auth';
import {
  createSurgeZoneSchema,
  updateSurgeZoneSchema,
  createSurgeWindowSchema,
  updateSurgeWindowSchema,
  updateCitySurgeSettingsSchema,
  listSurgeWindowsQuerySchema,
} from './surge.schema.js';
import { AdminSurgeService } from './surge.service.js';

export class AdminSurgeController {
  constructor(private readonly adminSurgeService: AdminSurgeService) {}

  async createSurgeZone(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const data = createSurgeZoneSchema.parse(req.body);
    const zone = await this.adminSurgeService.createSurgeZone(data, callerId(req));
    return reply.status(201).send({ data: zone });
  }

  async listSurgeZones(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const zones = await this.adminSurgeService.listSurgeZones();
    return reply.send({ data: zones });
  }

  async getSurgeZone(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = req.params as { id: string };
    const zone = await this.adminSurgeService.getSurgeZone(id);
    return reply.send({ data: zone });
  }

  async updateSurgeZone(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = req.params as { id: string };
    const data = updateSurgeZoneSchema.parse(req.body);
    await this.adminSurgeService.updateSurgeZone(id, data, callerId(req));
    return reply.send({ data: { success: true } });
  }

  async deleteSurgeZone(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = req.params as { id: string };
    await this.adminSurgeService.deleteSurgeZone(id, callerId(req));
    return reply.send({ data: { success: true } });
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
    return reply.status(201).send({ data: window });
  }

  async listSurgeWindows(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = listSurgeWindowsQuerySchema.parse(req.query ?? {});
    const result = await this.adminSurgeService.listSurgeWindows(query);
    return reply.send(result);
  }

  async getSurgeWindow(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = req.params as { id: string };
    const window = await this.adminSurgeService.getSurgeWindow(id);
    return reply.send({ data: window });
  }

  async listSurgeWindowVersions(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = req.params as { id: string };
    const versions = await this.adminSurgeService.listSurgeWindowVersions(id);
    return reply.send({ data: versions });
  }

  async updateSurgeWindow(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = req.params as { id: string };
    const data = updateSurgeWindowSchema.parse(req.body);
    const window = await this.adminSurgeService.updateSurgeWindow(
      id,
      {
        ...data,
        startsAt: data.startsAt ? new Date(data.startsAt) : undefined,
        endsAt: data.endsAt === null ? null : data.endsAt ? new Date(data.endsAt) : undefined,
      },
      callerId(req),
    );
    return reply.send({ data: window });
  }

  async updateCitySurgeSettings(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { cityCode } = req.params as { cityCode: string };
    const { maxSurgeMultiplier } = updateCitySurgeSettingsSchema.parse(req.body);
    const saved = await this.adminSurgeService.updateCitySurgeSettings(
      cityCode,
      maxSurgeMultiplier,
      callerId(req),
    );
    return reply.send({ data: saved });
  }

  async deleteSurgeWindow(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = req.params as { id: string };
    await this.adminSurgeService.deleteSurgeWindow(id, callerId(req));
    return reply.send({ data: { success: true } });
  }
}
