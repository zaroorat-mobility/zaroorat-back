import type { FastifyReply, FastifyRequest } from 'fastify';
import { errorEnvelope } from '@core/errors/envelope.js';
import { logger } from '@shared/logger/index.js';
import { AppConfigAdminService } from '../services/app-config-admin.service.js';
import {
  createLocaleSchema,
  resetThemeSchema,
  updateFontsSchema,
  updateLocaleSchema,
  updateThemeSchema,
  upsertTranslationsSchema,
  appClientSchema,
} from '../schemas/app-config.schemas.js';
import {
  DEFAULT_THEME_COMPONENTS,
  DEFAULT_THEME_TOKENS_DARK,
  DEFAULT_THEME_TOKENS_LIGHT,
} from '../constants/app-config.constants.js';
import type { Prisma } from '../../../generated/prisma/index.js';

export class AppConfigAdminController {
  constructor(private readonly appConfigAdminService: AppConfigAdminService) {}

  async listThemes(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const app =
        req.query && typeof req.query === 'object' && 'app' in req.query
          ? appClientSchema.optional().parse((req.query as { app?: string }).app)
          : undefined;
      reply.send({ data: await this.appConfigAdminService.listThemes(app) });
    } catch (error) {
      logger.error({ error }, '[AppConfigAdminController] listThemes');
      reply.status(500).send(errorEnvelope('INTERNAL_ERROR', 'Failed to list themes', req.id));
    }
  }

  async updateTheme(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const body = updateThemeSchema.parse(req.body);
      const data = await this.appConfigAdminService.updateTheme(body, req.auth?.userId);
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

  async listFonts(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const app = appClientSchema.parse((req.query as { app?: string }).app ?? 'driver');
      reply.send({ data: await this.appConfigAdminService.listFonts(app) });
    } catch (error) {
      logger.error({ error }, '[AppConfigAdminController] listFonts');
      reply.status(500).send(errorEnvelope('INTERNAL_ERROR', 'Failed to list fonts', req.id));
    }
  }

  async updateFonts(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const body = updateFontsSchema.parse(req.body);
      const data = await this.appConfigAdminService.updateFonts(body, req.auth?.userId);
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

  async listLocales(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      reply.send({ data: await this.appConfigAdminService.listLocales() });
    } catch (error) {
      logger.error({ error }, '[AppConfigAdminController] listLocales');
      reply.status(500).send(errorEnvelope('INTERNAL_ERROR', 'Failed to list locales', req.id));
    }
  }

  async updateLocale(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const body = updateLocaleSchema.parse(req.body);
      const data = await this.appConfigAdminService.updateLocale(body, req.auth?.userId);
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

  async createLocale(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const body = createLocaleSchema.parse(req.body);
      const data = await this.appConfigAdminService.createLocale(body, req.auth?.userId);
      reply.send({ data });
    } catch (error) {
      reply
        .status(400)
        .send(
          errorEnvelope(
            'SETTINGS_UPDATE_FAILED',
            error instanceof Error ? error.message : 'Create failed',
            req.id,
          ),
        );
    }
  }

  async listTranslations(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const query = req.query as { app?: string; locale?: string };
      const app = appClientSchema.parse(query.app ?? 'driver');
      const locale = typeof query.locale === 'string' ? query.locale : 'en';
      reply.send({ data: await this.appConfigAdminService.listTranslations(app, locale) });
    } catch (error) {
      logger.error({ error }, '[AppConfigAdminController] listTranslations');
      reply
        .status(500)
        .send(errorEnvelope('INTERNAL_ERROR', 'Failed to list translations', req.id));
    }
  }

  async upsertTranslations(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const body = upsertTranslationsSchema.parse(req.body);
      const data = await this.appConfigAdminService.upsertTranslations(body, req.auth?.userId);
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

  async publish(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const data = await this.appConfigAdminService.publish(req.auth?.userId);
      reply.send({ data });
    } catch (error) {
      logger.error({ error }, '[AppConfigAdminController] publish');
      reply
        .status(500)
        .send(errorEnvelope('INTERNAL_ERROR', 'Failed to publish app config', req.id));
    }
  }

  async resetTheme(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const body = resetThemeSchema.parse(req.body);
      const tokens = (body.tokens ??
        (body.colorScheme === 'dark'
          ? DEFAULT_THEME_TOKENS_DARK
          : DEFAULT_THEME_TOKENS_LIGHT)) as Prisma.InputJsonValue;
      const components = (body.components ?? DEFAULT_THEME_COMPONENTS) as Prisma.InputJsonValue;
      const data = await this.appConfigAdminService.resetToDefaults(
        body.app,
        body.colorScheme,
        tokens,
        components,
        req.auth?.userId,
      );
      reply.send({ data });
    } catch (error) {
      reply
        .status(400)
        .send(
          errorEnvelope(
            'SETTINGS_UPDATE_FAILED',
            error instanceof Error ? error.message : 'Reset failed',
            req.id,
          ),
        );
    }
  }
}
