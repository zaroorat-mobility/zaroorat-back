import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppConfigService } from '../services/app-config.service.js';
import { getAppConfigQuerySchema } from '../schemas/app-config.schemas.js';
import type { AppClientSlug } from '../constants/app-config.constants.js';

function etagForVersion(version: number): string {
  return `W/"app-config-v${version}"`;
}

interface PlatformConfigResolverLike {
  getGeneralConfig(app?: string): Promise<{ logoUrl?: string | null }>;
}

export class AppConfigController {
  constructor(private readonly appConfigService: AppConfigService) {}

  async getConfig(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = getAppConfigQuerySchema.parse(req.query);
    // The ETag is the version alone, so a revalidation is answered from one
    // settings lookup instead of assembling (and discarding) the whole bundle.
    const current = etagForVersion(await this.appConfigService.getVersion());
    if (req.headers['if-none-match'] === current) {
      reply.header('ETag', current).status(304).send();
      return;
    }

    const data = await this.appConfigService.getPublicBundle(query.app, query.locale);
    reply.header('ETag', etagForVersion(data.version));
    reply.header('Cache-Control', 'public, max-age=300');
    reply.send({ data });
  }

  async getLocaleStrings(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { code } = req.params as { code: string };
    const query = getAppConfigQuerySchema.pick({ app: true }).parse(req.query);
    const data = await this.appConfigService.getLocaleStrings(query.app as AppClientSlug, code);
    reply.send({ data });
  }

  async getBrandLogo(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = req.query as { app?: string };
    const appClient: AppClientSlug = query.app === 'driver' ? 'driver' : 'rider';
    try {
      const { container } = await import('@core/di.js');
      if (container.hasRegistration('platformConfigResolver')) {
        const resolver = container.resolve<PlatformConfigResolverLike>('platformConfigResolver');
        const config = await resolver.getGeneralConfig(appClient);
        if (config.logoUrl) {
          reply
            .header('Cache-Control', 'public, max-age=1800')
            .status(302)
            .redirect(config.logoUrl);
          return;
        }
      }
    } catch (err) {
      req.log.warn({ err }, '[getBrandLogo] Failed to resolve via platformConfigResolver');
    }

    const bundle = await this.appConfigService.getPublicBundle(appClient, 'en');
    const logoUrl = bundle.settings?.general?.logoUrl;
    if (!logoUrl) {
      reply.status(404).send({ error: 'No brand logo configured' });
      return;
    }
    reply.header('Cache-Control', 'public, max-age=1800').status(302).redirect(logoUrl);
  }
}
