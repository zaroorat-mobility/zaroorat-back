import type { FastifyReply, FastifyRequest } from 'fastify';
import { DriverService } from '../services/driver.service.js';
import { DriverRepository } from '../repositories/driver.repository.js';
import { heartbeatSchema } from '../schemas/driver.schemas.js';
import { actingDriverId } from './driver-identity.js';
export class DriverStatusController {
  constructor(
    private readonly driverService: DriverService,
    private readonly driverRepository: DriverRepository,
  ) {}
  async setOnline(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const driverId = await actingDriverId(req, this.driverRepository);
    const parsed = req.body ? heartbeatSchema.partial().parse(req.body) : undefined;
    const statusParams: Record<string, unknown> = {};
    if (parsed?.batteryLevel !== undefined) statusParams.batteryLevel = parsed.batteryLevel;
    if (parsed?.networkType !== undefined) statusParams.networkType = parsed.networkType;
    const status = await this.driverService.status.setOnline(
      driverId,
      Object.keys(statusParams).length ? statusParams : undefined,
    );
    reply.send({ data: status });
  }
  async setOffline(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const driverId = await actingDriverId(req, this.driverRepository);
    const status = await this.driverService.status.setOffline(driverId);
    reply.send({ data: status });
  }
  async heartbeat(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const driverId = await actingDriverId(req, this.driverRepository);
    const body = heartbeatSchema.parse(req.body);
    const hbParams: Record<string, unknown> = {};
    if (body.batteryLevel !== undefined) hbParams.batteryLevel = body.batteryLevel;
    if (body.networkType !== undefined) hbParams.networkType = body.networkType;
    await this.driverService.status.recordHeartbeat(driverId, hbParams);
    reply.send({ data: { success: true, timestamp: new Date().toISOString() } });
  }
}
