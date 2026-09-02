import type { FastifyReply, FastifyRequest } from 'fastify';
import { callerId } from '@core/auth';
import { AdminGeographicService } from './admin-geographic.service.js';
import {
  cityIdParamSchema,
  createCityBodySchema,
  createServiceZoneBodySchema,
  createStateBodySchema,
  listCitiesQuerySchema,
  listServiceZonesQuerySchema,
  listStatesQuerySchema,
  serviceZoneIdParamSchema,
  stateIdParamSchema,
  updateCityBodySchema,
  updateServiceZoneBodySchema,
  updateStateBodySchema,
} from './geo.schemas.js';

export class AdminGeographicController {
  constructor(private readonly adminGeographicService: AdminGeographicService) {}

  async listCountries(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const result = await this.adminGeographicService.listCountries();
    reply.send(result);
  }

  async listStates(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = listStatesQuerySchema.parse(req.query);
    const result = await this.adminGeographicService.listStates({
      ...(query.countryCode !== undefined ? { countryCode: query.countryCode } : {}),
      activeOnly: query.activeOnly,
    });
    reply.send(result);
  }

  async createState(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const body = createStateBodySchema.parse(req.body);
    const data = await this.adminGeographicService.createState(body, callerId(req));
    reply.status(201).send({ data });
  }

  async updateState(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = stateIdParamSchema.parse(req.params);
    const body = updateStateBodySchema.parse(req.body ?? {});
    const data = await this.adminGeographicService.updateState(id, body, callerId(req));
    reply.send({ data });
  }

  async listCities(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = listCitiesQuerySchema.parse(req.query);
    const result = await this.adminGeographicService.listCities({
      ...(query.countryCode !== undefined ? { countryCode: query.countryCode } : {}),
      ...(query.stateId !== undefined ? { stateId: query.stateId } : {}),
      activeOnly: query.activeOnly,
    });
    reply.send(result);
  }

  async getCity(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = cityIdParamSchema.parse(req.params);
    const data = await this.adminGeographicService.getCityById(id);
    reply.send({ data });
  }

  async createCity(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const body = createCityBodySchema.parse(req.body);
    const data = await this.adminGeographicService.createCity(body, callerId(req));
    reply.status(201).send({ data });
  }

  async updateCity(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = cityIdParamSchema.parse(req.params);
    const body = updateCityBodySchema.parse(req.body ?? {});
    const data = await this.adminGeographicService.updateCity(id, body, callerId(req));
    reply.send({ data });
  }

  async listServiceZones(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = listServiceZonesQuerySchema.parse(req.query);
    const result = await this.adminGeographicService.listServiceZones({
      ...(query.cityCode !== undefined ? { cityCode: query.cityCode } : {}),
      ...(query.zoneType !== undefined ? { zoneType: query.zoneType } : {}),
      activeOnly: query.activeOnly,
    });
    reply.send(result);
  }

  async getServiceZone(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = serviceZoneIdParamSchema.parse(req.params);
    const data = await this.adminGeographicService.getServiceZoneById(id);
    reply.send({ data });
  }

  async createServiceZone(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const body = createServiceZoneBodySchema.parse(req.body);
    const data = await this.adminGeographicService.createServiceZone(body, callerId(req));
    reply.status(201).send({ data });
  }

  async updateServiceZone(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = serviceZoneIdParamSchema.parse(req.params);
    const body = updateServiceZoneBodySchema.parse(req.body ?? {});
    const data = await this.adminGeographicService.updateServiceZone(id, body, callerId(req));
    reply.send({ data });
  }

  async activateServiceZone(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = serviceZoneIdParamSchema.parse(req.params);
    const data = await this.adminGeographicService.activateServiceZone(id, callerId(req));
    reply.send({ data });
  }

  async deactivateServiceZone(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = serviceZoneIdParamSchema.parse(req.params);
    const data = await this.adminGeographicService.deactivateServiceZone(id, callerId(req));
    reply.send({ data });
  }
}
