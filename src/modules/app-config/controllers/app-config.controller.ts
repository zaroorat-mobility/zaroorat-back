import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppConfigService } from '../services/app-config.service.js';
import { getAppConfigQuerySchema } from '../schemas/app-config.schemas.js';
import type { AppClientSlug } from '../constants/app-config.constants.js';

function etagForVersion(version: number): string {
  return `W/"app-config-v${version}"`;
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
}
