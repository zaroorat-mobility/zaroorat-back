import type { FastifyReply, FastifyRequest } from 'fastify';
import { MapProviderService } from '../business-services/map-provider.service.js';
import { AdminMapSettingsService } from '@modules/admin/system-settings/map/services/admin-map-settings.service.js';
import {
  autocompleteQuerySchema,
  geocodeBodySchema,
  placeDetailsParamsSchema,
  reverseGeocodeBodySchema,
  routeBodySchema,
  routeMatrixBodySchema,
} from '../schemas/maps-api.schemas.js';
import { errorEnvelope } from '@core/errors/envelope.js';
import { RoutingProviderUnavailableError } from '../errors/location.errors.js';

export class MapsController {
  constructor(
    private readonly mapProviderService: MapProviderService,
    private readonly adminMapSettingsService: AdminMapSettingsService,
  ) {}

  async getConfig(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const data = await this.adminMapSettingsService.getPublicMapConfig();
    reply.send({ data });
  }

  async autocomplete(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = autocompleteQuerySchema.parse(req.query);
    const location =
      query.latitude != null && query.longitude != null
        ? { latitude: query.latitude, longitude: query.longitude }
        : undefined;
    const data = await this.mapProviderService.autocomplete(query.input, location);
    reply.send({ data });
  }

  async geocode(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const body = geocodeBodySchema.parse(req.body);
      const data = await this.mapProviderService.forwardGeocode(body.address);
      reply.send({ data });
    } catch (err) {
      this.handleMapError(req, reply, err);
    }
  }

  async reverseGeocode(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const body = reverseGeocodeBodySchema.parse(req.body);
      const data = await this.mapProviderService.reverseGeocode({
        latitude: body.latitude,
        longitude: body.longitude,
      });
      reply.send({ data });
    } catch (err) {
      this.handleMapError(req, reply, err);
    }
  }

  async route(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const body = routeBodySchema.parse(req.body);
      const data = await this.mapProviderService.getDirections(
        { latitude: body.originLat, longitude: body.originLng },
        { latitude: body.destinationLat, longitude: body.destinationLng },
      );
      reply.send({ data });
    } catch (err) {
      this.handleMapError(req, reply, err);
    }
  }

  async placeDetails(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const params = placeDetailsParamsSchema.parse(req.params);
      const data = await this.mapProviderService.getPlaceDetails(params.placeId, params.provider);
      reply.send({ data });
    } catch (err) {
      this.handleMapError(req, reply, err);
    }
  }

  async routeMatrix(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const body = routeMatrixBodySchema.parse(req.body);
      const data = await this.mapProviderService.getDistanceMatrix(body.origins, body.destinations);
      reply.send({ data });
    } catch (err) {
      this.handleMapError(req, reply, err);
    }
  }

  private handleMapError(req: FastifyRequest, reply: FastifyReply, err: unknown): void {
    if (err instanceof RoutingProviderUnavailableError) {
      reply.status(err.statusCode).send(errorEnvelope(err.code, err.message, req.id));
      return;
    }
    throw err;
  }
}
