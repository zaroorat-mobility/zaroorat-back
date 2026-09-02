import type { FastifyReply, FastifyRequest } from 'fastify';
import { AdminPlatformSettingsService } from '../services/admin-platform-settings.service.js';
import {
  updateGeneralSettingsSchema,
  updateRideSettingsSchema,
  updateOtpSettingsSchema,
  updateOnboardingSettingsSchema,
  updateFeatureFlagsSchema,
  updateMaintenanceSettingsSchema,
} from '../schemas/platform-settings.schema.js';
import { errorEnvelope } from '@core/errors/envelope.js';
import { logger } from '@shared/logger/index.js';

export class AdminPlatformSettingsController {
  constructor(private readonly adminPlatformSettingsService: AdminPlatformSettingsService) {}

  async getGeneral(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      reply.send({ data: await this.adminPlatformSettingsService.getGeneralSettings() });
    } catch (error) {
      logger.error({ error }, '[AdminPlatformSettingsController] getGeneral');
      reply
        .status(500)
        .send(errorEnvelope('INTERNAL_ERROR', 'Failed to fetch general settings', req.id));
    }
  }

  async updateGeneral(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const body = updateGeneralSettingsSchema.parse(req.body);
      const data = await this.adminPlatformSettingsService.updateGeneralSettings(
        body,
        req.auth?.userId,
      );
      reply.send({ data });
    } catch (error) {
      reply
        .status(400)
        .send(
          errorEnvelope(
            'SETTINGS_UPDATE_FAILED',
            error instanceof Error ? error.message : 'Update failed',
            req.id,
          ),
        );
    }
  }

  async getRide(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      reply.send({ data: await this.adminPlatformSettingsService.getRideSettings() });
    } catch (_error) {
      reply
        .status(500)
        .send(errorEnvelope('INTERNAL_ERROR', 'Failed to fetch ride settings', req.id));
    }
  }

  async updateRide(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const body = updateRideSettingsSchema.parse(req.body);
      const data = await this.adminPlatformSettingsService.updateRideSettings(
        body,
        req.auth?.userId,
      );
      reply.send({ data });
    } catch (error) {
      reply
        .status(400)
        .send(
          errorEnvelope(
            'SETTINGS_UPDATE_FAILED',
            error instanceof Error ? error.message : 'Update failed',
            req.id,
          ),
        );
    }
  }

  async getOtp(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      reply.send({ data: await this.adminPlatformSettingsService.getOtpSettings() });
    } catch (_error) {
      reply
        .status(500)
        .send(errorEnvelope('INTERNAL_ERROR', 'Failed to fetch OTP settings', req.id));
    }
  }

  async updateOtp(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const body = updateOtpSettingsSchema.parse(req.body);
      const data = await this.adminPlatformSettingsService.updateOtpSettings(
        body,
        req.auth?.userId,
      );
      reply.send({ data });
    } catch (error) {
      reply
        .status(400)
        .send(
          errorEnvelope(
            'SETTINGS_UPDATE_FAILED',
            error instanceof Error ? error.message : 'Update failed',
            req.id,
          ),
        );
    }
  }

  async getOnboarding(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      reply.send({ data: await this.adminPlatformSettingsService.getOnboardingSettings() });
    } catch (_error) {
      reply
        .status(500)
        .send(errorEnvelope('INTERNAL_ERROR', 'Failed to fetch onboarding settings', req.id));
    }
  }

  async updateOnboarding(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const body = updateOnboardingSettingsSchema.parse(req.body);
      const data = await this.adminPlatformSettingsService.updateOnboardingSettings(
        body,
        req.auth?.userId,
      );
      reply.send({ data });
    } catch (error) {
      reply
        .status(400)
        .send(
          errorEnvelope(
            'SETTINGS_UPDATE_FAILED',
            error instanceof Error ? error.message : 'Update failed',
            req.id,
          ),
        );
    }
  }

  async getFeatureFlags(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      reply.send({ data: await this.adminPlatformSettingsService.getFeatureFlags() });
    } catch (_error) {
      reply
        .status(500)
        .send(errorEnvelope('INTERNAL_ERROR', 'Failed to fetch feature flags', req.id));
    }
  }

  async updateFeatureFlags(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const body = updateFeatureFlagsSchema.parse(req.body);
      const data = await this.adminPlatformSettingsService.updateFeatureFlags(
        body,
        req.auth?.userId,
      );
      reply.send({ data });
    } catch (error) {
      reply
        .status(400)
        .send(
          errorEnvelope(
            'SETTINGS_UPDATE_FAILED',
            error instanceof Error ? error.message : 'Update failed',
            req.id,
          ),
        );
    }
  }

  async getMaintenance(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      reply.send({ data: await this.adminPlatformSettingsService.getMaintenanceSettings() });
    } catch (_error) {
      reply
        .status(500)
        .send(errorEnvelope('INTERNAL_ERROR', 'Failed to fetch maintenance settings', req.id));
    }
  }

  async updateMaintenance(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const body = updateMaintenanceSettingsSchema.parse(req.body);
      const data = await this.adminPlatformSettingsService.updateMaintenanceSettings(
        body,
        req.auth?.userId,
      );
      reply.send({ data });
    } catch (error) {
      reply
        .status(400)
        .send(
          errorEnvelope(
            'SETTINGS_UPDATE_FAILED',
            error instanceof Error ? error.message : 'Update failed',
            req.id,
          ),
        );
    }
  }
}
