import type { FastifyReply, FastifyRequest } from 'fastify';
import { AdminMapSettingsService } from '../services/admin-map-settings.service.js';
import {
  updateMapSettingsBodySchema,
  testProviderHealthBodySchema,
} from '../schemas/map-settings.schema.js';
import { errorEnvelope } from '@core/errors/envelope.js';
import { logger } from '@shared/logger/index.js';

export class AdminMapSettingsController {
  constructor(private readonly adminMapSettingsService: AdminMapSettingsService) {}

  async getMapSettings(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const data = await this.adminMapSettingsService.getMapSettings();
      reply.send({ data });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to fetch map settings';
      logger.error({ error }, '[AdminMapSettingsController] getMapSettings error');
      reply.status(500).send(errorEnvelope('INTERNAL_ERROR', message, request.id));
    }
  }

  async updateMapSettings(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const body = updateMapSettingsBodySchema.parse(request.body);
      const actorId = request.auth?.userId;
      const data = await this.adminMapSettingsService.updateMapSettings(body, actorId);
      reply.send({ data });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update map settings';
      logger.warn({ error }, '[AdminMapSettingsController] updateMapSettings validation/conflict');
      reply.status(400).send(errorEnvelope('SETTINGS_UPDATE_FAILED', message, request.id));
    }
  }

  async testProvider(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const body = testProviderHealthBodySchema.parse(request.body);
      const data = await this.adminMapSettingsService.testProviderHealth(body);
      reply.send({ data });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Provider test failed';
      logger.warn({ error }, '[AdminMapSettingsController] testProvider error');
      reply.status(400).send(errorEnvelope('PROVIDER_TEST_FAILED', message, request.id));
    }
  }
}
