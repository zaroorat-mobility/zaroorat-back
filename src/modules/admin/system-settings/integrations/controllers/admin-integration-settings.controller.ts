import type { FastifyReply, FastifyRequest } from 'fastify';
import { errorEnvelope } from '@core/errors/envelope.js';
import { logger } from '@shared/logger/index.js';
import { AdminMapSettingsService } from '../../map/services/admin-map-settings.service.js';
import { AdminPaymentSettingsService } from '../services/admin-payment-settings.service.js';
import { AdminSmsSettingsService } from '../services/admin-sms-settings.service.js';
import { AdminPushSettingsService } from '../services/admin-push-settings.service.js';
import { AdminEmailSettingsService } from '../services/admin-email-settings.service.js';
import { IntegrationHealthService } from '../services/integration-health.service.js';
import {
  updatePaymentSettingsSchema,
  updateSmsSettingsSchema,
  updatePushSettingsSchema,
  updateEmailSettingsSchema,
  integrationTestSchema,
} from '../schemas/integration-settings.schema.js';
import type { UpdatePaymentSettingsBody } from '../types/integration-settings.types.js';
import type { UpdateSmsSettingsBody } from '../types/integration-settings.types.js';
import type { UpdatePushSettingsBody } from '../types/integration-settings.types.js';
import type { UpdateEmailSettingsBody } from '../types/integration-settings.types.js';
import type { IntegrationTestInput } from '../types/integration-settings.types.js';

export class AdminIntegrationSettingsController {
  constructor(
    private readonly adminPaymentSettingsService: AdminPaymentSettingsService,
    private readonly adminSmsSettingsService: AdminSmsSettingsService,
    private readonly adminPushSettingsService: AdminPushSettingsService,
    private readonly adminEmailSettingsService: AdminEmailSettingsService,
    private readonly adminMapSettingsService: AdminMapSettingsService,
    private readonly integrationHealthService: IntegrationHealthService,
  ) {}

  async getPaymentSettings(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      reply.send({ data: await this.adminPaymentSettingsService.getPaymentSettings() });
    } catch (error) {
      logger.error({ error }, '[AdminIntegrationSettingsController] getPaymentSettings');
      reply
        .status(500)
        .send(errorEnvelope('INTERNAL_ERROR', 'Failed to fetch payment settings', req.id));
    }
  }

  async updatePaymentSettings(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const body = updatePaymentSettingsSchema.parse(req.body) as UpdatePaymentSettingsBody;
      const data = await this.adminPaymentSettingsService.updatePaymentSettings(
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

  async testPayment(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const body = integrationTestSchema.parse(req.body ?? {}) as IntegrationTestInput;
      reply.send({ data: await this.adminPaymentSettingsService.testPayment(body) });
    } catch (error) {
      reply
        .status(400)
        .send(
          errorEnvelope(
            'PROVIDER_TEST_FAILED',
            error instanceof Error ? error.message : 'Payment test failed',
            req.id,
          ),
        );
    }
  }

  async getSmsSettings(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      reply.send({ data: await this.adminSmsSettingsService.getSmsSettings() });
    } catch (error) {
      logger.error({ error }, '[AdminIntegrationSettingsController] getSmsSettings');
      reply
        .status(500)
        .send(errorEnvelope('INTERNAL_ERROR', 'Failed to fetch SMS settings', req.id));
    }
  }

  async updateSmsSettings(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const body = updateSmsSettingsSchema.parse(req.body) as UpdateSmsSettingsBody;
      const data = await this.adminSmsSettingsService.updateSmsSettings(body, req.auth?.userId);
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

  async testSms(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const body = integrationTestSchema.parse(req.body ?? {}) as IntegrationTestInput;
      reply.send({ data: await this.adminSmsSettingsService.testSms(body) });
    } catch (error) {
      reply
        .status(400)
        .send(
          errorEnvelope(
            'PROVIDER_TEST_FAILED',
            error instanceof Error ? error.message : 'SMS test failed',
            req.id,
          ),
        );
    }
  }

  async getPushSettings(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      reply.send({ data: await this.adminPushSettingsService.getPushSettings() });
    } catch (error) {
      logger.error({ error }, '[AdminIntegrationSettingsController] getPushSettings');
      reply
        .status(500)
        .send(errorEnvelope('INTERNAL_ERROR', 'Failed to fetch push settings', req.id));
    }
  }

  async updatePushSettings(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const body = updatePushSettingsSchema.parse(req.body) as UpdatePushSettingsBody;
      const data = await this.adminPushSettingsService.updatePushSettings(body, req.auth?.userId);
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

  async testPush(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const body = integrationTestSchema.parse(req.body ?? {}) as IntegrationTestInput;
      reply.send({ data: await this.adminPushSettingsService.testPush(body) });
    } catch (error) {
      reply
        .status(400)
        .send(
          errorEnvelope(
            'PROVIDER_TEST_FAILED',
            error instanceof Error ? error.message : 'Push test failed',
            req.id,
          ),
        );
    }
  }

  async getEmailSettings(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      reply.send({ data: await this.adminEmailSettingsService.getEmailSettings() });
    } catch (error) {
      logger.error({ error }, '[AdminIntegrationSettingsController] getEmailSettings');
      reply
        .status(500)
        .send(errorEnvelope('INTERNAL_ERROR', 'Failed to fetch email settings', req.id));
    }
  }

  async updateEmailSettings(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const body = updateEmailSettingsSchema.parse(req.body) as UpdateEmailSettingsBody;
      const data = await this.adminEmailSettingsService.updateEmailSettings(body, req.auth?.userId);
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

  async testEmail(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const body = integrationTestSchema.parse(req.body ?? {}) as IntegrationTestInput;
      reply.send({ data: await this.adminEmailSettingsService.testEmail(body) });
    } catch (error) {
      reply
        .status(400)
        .send(
          errorEnvelope(
            'PROVIDER_TEST_FAILED',
            error instanceof Error ? error.message : 'Email test failed',
            req.id,
          ),
        );
    }
  }

  async getIntegrationsStatus(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const [payment, sms, push, email, maps] = await Promise.all([
        this.adminPaymentSettingsService.getPaymentSettings(),
        this.adminSmsSettingsService.getSmsSettings(),
        this.adminPushSettingsService.getPushSettings(),
        this.adminEmailSettingsService.getEmailSettings(),
        this.adminMapSettingsService.getMapSettings(),
      ]);

      const fallbacks = [
        this.adminPaymentSettingsService.getHealthFallback(payment),
        this.adminSmsSettingsService.getHealthFallback(sms),
        this.adminPushSettingsService.getHealthFallback(push),
        this.adminEmailSettingsService.getHealthFallback(email),
        {
          integration: 'maps' as const,
          provider: maps.primaryProvider,
          configured:
            maps.providers[maps.primaryProvider as keyof typeof maps.providers]?.configured ??
            false,
        },
      ];

      reply.send({ data: await this.integrationHealthService.getAggregateStatus(fallbacks) });
    } catch (error) {
      logger.error({ error }, '[AdminIntegrationSettingsController] getIntegrationsStatus');
      reply
        .status(500)
        .send(errorEnvelope('INTERNAL_ERROR', 'Failed to fetch integration status', req.id));
    }
  }

  async getMapClientConfig(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      reply.send({ data: await this.adminMapSettingsService.getMapClientConfig() });
    } catch (error) {
      logger.error({ error }, '[AdminIntegrationSettingsController] getMapClientConfig');
      reply
        .status(500)
        .send(errorEnvelope('INTERNAL_ERROR', 'Failed to fetch map client config', req.id));
    }
  }
}
