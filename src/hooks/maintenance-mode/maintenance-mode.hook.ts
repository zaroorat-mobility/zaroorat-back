import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { container } from '@core/di';
import { AdminPlatformSettingsService } from '@modules/admin/system-settings/platform/services/admin-platform-settings.service.js';
import { errorEnvelope } from '@core/errors/envelope.js';

const MAINTENANCE_EXEMPT_PREFIXES = [
  '/health',
  '/ready',
  '/metrics',
  '/api/v1/health',
  '/api/v1/ready',
  '/api/v1/auth/admin',
  '/api/v1/admin/settings',
  '/api/v1/admin/monitoring',
  '/api/v1/admin/security',
];

async function maintenanceModeHook(app: FastifyInstance) {
  app.addHook('preHandler', async (request, reply) => {
    const path = request.url.split('?')[0] ?? request.url;
    if (MAINTENANCE_EXEMPT_PREFIXES.some((prefix) => path.startsWith(prefix))) return;

    const service = container.resolve<AdminPlatformSettingsService>('adminPlatformSettingsService');
    const maintenance = await service.isMaintenanceActive();
    if (!maintenance.active) return;

    const isAdminRoute = path.startsWith('/api/v1/admin');
    const isAdminAuth = path.startsWith('/api/v1/auth/admin');
    if (maintenance.allowAdminAccess && (isAdminRoute || isAdminAuth)) return;

    if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'OPTIONS') {
      reply.status(503).send(
        errorEnvelope('MAINTENANCE_MODE', maintenance.message, request.id, {
          maintenance: true,
        }),
      );
    }
  });
}

export default fp(maintenanceModeHook, { name: 'maintenance-mode-hook' });
