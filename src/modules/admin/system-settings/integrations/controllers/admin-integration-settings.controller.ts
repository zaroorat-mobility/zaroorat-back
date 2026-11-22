import type { FastifyReply, FastifyRequest } from 'fastify';
import { DatabaseService } from '@core/database';
import { errorEnvelope, rethrowServerFault } from '@core/errors/envelope.js';
import { auditActor, auditExternalAction } from '../../../audit/index.js';
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
  paymentIntegrationTestSchema,
} from '../schemas/integration-settings.schema.js';
import type { UpdatePaymentSettingsBody } from '../types/integration-settings.types.js';
import type { PaymentIntegrationTestInput } from '../services/admin-payment-settings.service.js';
import type { UpdateSmsSettingsBody } from '../types/integration-settings.types.js';
import type { UpdatePushSettingsBody } from '../types/integration-settings.types.js';
import type { UpdateEmailSettingsBody } from '../types/integration-settings.types.js';
import type {
  IntegrationTestInput,
  IntegrationTestResult,
} from '../types/integration-settings.types.js';

/// Enough of a recipient to tell which one was messaged, not enough to reuse it.
function maskRecipient(input: { testPhone?: string; testEmail?: string }): string | null {
  if (input.testPhone) return `***${input.testPhone.slice(-4)}`;
  if (input.testEmail) {
    const [local = '', domain = ''] = input.testEmail.split('@');
    return `${local.slice(0, 1)}***@${domain}`;
  }
  return null;
}

export class AdminIntegrationSettingsController {
  constructor(
    private readonly adminPaymentSettingsService: AdminPaymentSettingsService,
    private readonly adminSmsSettingsService: AdminSmsSettingsService,
    private readonly adminPushSettingsService: AdminPushSettingsService,
    private readonly adminEmailSettingsService: AdminEmailSettingsService,
    private readonly adminMapSettingsService: AdminMapSettingsService,
    private readonly integrationHealthService: IntegrationHealthService,
    private readonly databaseService: DatabaseService,
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
      rethrowServerFault(error);
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
      const body = paymentIntegrationTestSchema.parse(
        req.body ?? {},
      ) as PaymentIntegrationTestInput;
      reply.send({
        data: await this.audited(req, 'payment', {}, () =>
          this.adminPaymentSettingsService.testPayment(body),
        ),
      });
    } catch (error) {
      rethrowServerFault(error);
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

  /// Per-provider payment gateway health — enabled/disabled, environment,
  /// configured, last successful/failed probe — for Razorpay and Stripe at
  /// once. Never exposes a secret value.
  async getPaymentProvidersHealth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      reply.send({ data: await this.adminPaymentSettingsService.getPaymentProvidersHealth() });
    } catch (error) {
      logger.error({ error }, '[AdminIntegrationSettingsController] getPaymentProvidersHealth');
      reply
        .status(500)
        .send(errorEnvelope('INTERNAL_ERROR', 'Failed to fetch payment provider health', req.id));
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
      rethrowServerFault(error);
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
      reply.send({
        data: await this.audited(req, 'sms', body, () =>
          this.adminSmsSettingsService.testSms(body),
        ),
      });
    } catch (error) {
      rethrowServerFault(error);
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
      rethrowServerFault(error);
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
      reply.send({
        data: await this.audited(req, 'push', body, () =>
          this.adminPushSettingsService.testPush(body),
        ),
      });
    } catch (error) {
      rethrowServerFault(error);
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
      rethrowServerFault(error);
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
      reply.send({
        data: await this.audited(req, 'email', body, () =>
          this.adminEmailSettingsService.testEmail(body),
        ),
      });
    } catch (error) {
      rethrowServerFault(error);
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

  /// Integration tests reach the real provider: SMS and email send to the recipient the
  /// operator types, and the payment test creates a gateway order. Kept enabled — finance
  /// and ops need them after rotating credentials — behind `settings:write`, and audited
  /// as an external action: REQUESTED before the provider is called, then SUCCESS or
  /// FAILED as the provider answered. The row carries the integration, provider, outcome
  /// and a masked recipient; never the message, the provider's text (which can echo the
  /// address), credentials, or the full phone number or email.
  private audited(
    req: FastifyRequest,
    integration: 'payment' | 'sms' | 'push' | 'email',
    input: { testPhone?: string; testEmail?: string },
    run: () => Promise<IntegrationTestResult>,
  ): Promise<IntegrationTestResult> {
    return auditExternalAction(
      this.databaseService.client,
      {
        ...auditActor(req),
        action: 'CREATE',
        entityType: 'integration_test',
        summary: `${integration} integration test`,
        before: { integration, recipient: maskRecipient(input) },
      },
      run,
      (result) => ({
        outcome: result.ok ? 'SUCCESS' : 'FAILED',
        after: {
          integration: result.integration,
          provider: result.provider,
          ok: result.ok,
          responseTimeMs: result.responseTimeMs,
        },
      }),
    );
  }
}
