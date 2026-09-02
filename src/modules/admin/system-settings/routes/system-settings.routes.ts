import type { FastifyInstance } from 'fastify';
import { container } from '@core/di';
import { AdminMapSettingsController } from '../map/controllers/admin-map-settings.controller.js';
import { AdminPlatformSettingsController } from '../platform/controllers/admin-platform-settings.controller.js';
import { AdminIntegrationSettingsController } from '../integrations/controllers/admin-integration-settings.controller.js';

export async function systemSettingsRoutes(fastify: FastifyInstance): Promise<void> {
  const mapController = container.resolve<AdminMapSettingsController>('adminMapSettingsController');
  const platformController = container.resolve<AdminPlatformSettingsController>(
    'adminPlatformSettingsController',
  );
  const integrationController = container.resolve<AdminIntegrationSettingsController>(
    'adminIntegrationSettingsController',
  );

  const canRead = { preHandler: fastify.authorize({ permissions: ['settings:read'] }) };
  const canWrite = { preHandler: fastify.authorize({ permissions: ['settings:write'] }) };

  fastify.get('/settings/maps', canRead, (req, reply) => mapController.getMapSettings(req, reply));
  fastify.put('/settings/maps', canWrite, (req, reply) =>
    mapController.updateMapSettings(req, reply),
  );
  fastify.post('/settings/maps/test', canWrite, (req, reply) =>
    mapController.testProvider(req, reply),
  );
  fastify.get('/settings/maps/client-config', canRead, (req, reply) =>
    integrationController.getMapClientConfig(req, reply),
  );

  fastify.get('/settings/integrations/payment', canRead, (req, reply) =>
    integrationController.getPaymentSettings(req, reply),
  );
  fastify.put('/settings/integrations/payment', canWrite, (req, reply) =>
    integrationController.updatePaymentSettings(req, reply),
  );
  fastify.post('/settings/integrations/payment/test', canWrite, (req, reply) =>
    integrationController.testPayment(req, reply),
  );

  fastify.get('/settings/integrations/sms', canRead, (req, reply) =>
    integrationController.getSmsSettings(req, reply),
  );
  fastify.put('/settings/integrations/sms', canWrite, (req, reply) =>
    integrationController.updateSmsSettings(req, reply),
  );
  fastify.post('/settings/integrations/sms/test', canWrite, (req, reply) =>
    integrationController.testSms(req, reply),
  );

  fastify.get('/settings/integrations/push', canRead, (req, reply) =>
    integrationController.getPushSettings(req, reply),
  );
  fastify.put('/settings/integrations/push', canWrite, (req, reply) =>
    integrationController.updatePushSettings(req, reply),
  );
  fastify.post('/settings/integrations/push/test', canWrite, (req, reply) =>
    integrationController.testPush(req, reply),
  );

  fastify.get('/settings/integrations/email', canRead, (req, reply) =>
    integrationController.getEmailSettings(req, reply),
  );
  fastify.put('/settings/integrations/email', canWrite, (req, reply) =>
    integrationController.updateEmailSettings(req, reply),
  );
  fastify.post('/settings/integrations/email/test', canWrite, (req, reply) =>
    integrationController.testEmail(req, reply),
  );

  fastify.get('/settings/integrations/status', canRead, (req, reply) =>
    integrationController.getIntegrationsStatus(req, reply),
  );

  fastify.get('/settings/general', canRead, (req, reply) =>
    platformController.getGeneral(req, reply),
  );
  fastify.put('/settings/general', canWrite, (req, reply) =>
    platformController.updateGeneral(req, reply),
  );
  fastify.get('/settings/ride', canRead, (req, reply) => platformController.getRide(req, reply));
  fastify.put('/settings/ride', canWrite, (req, reply) =>
    platformController.updateRide(req, reply),
  );
  fastify.get('/settings/otp', canRead, (req, reply) => platformController.getOtp(req, reply));
  fastify.put('/settings/otp', canWrite, (req, reply) => platformController.updateOtp(req, reply));
  fastify.get('/settings/onboarding', canRead, (req, reply) =>
    platformController.getOnboarding(req, reply),
  );
  fastify.put('/settings/onboarding', canWrite, (req, reply) =>
    platformController.updateOnboarding(req, reply),
  );
  fastify.get('/settings/feature-flags', canRead, (req, reply) =>
    platformController.getFeatureFlags(req, reply),
  );
  fastify.put('/settings/feature-flags', canWrite, (req, reply) =>
    platformController.updateFeatureFlags(req, reply),
  );
  fastify.get('/settings/maintenance', canRead, (req, reply) =>
    platformController.getMaintenance(req, reply),
  );
  fastify.put('/settings/maintenance', canWrite, (req, reply) =>
    platformController.updateMaintenance(req, reply),
  );
}
