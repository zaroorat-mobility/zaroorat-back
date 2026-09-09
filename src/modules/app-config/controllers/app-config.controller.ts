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
    const data = await this.appConfigService.getPublicBundle(query.app, query.locale);
    const etag = etagForVersion(data.version);
    const ifNoneMatch = req.headers['if-none-match'];

    reply.header('ETag', etag);
    if (ifNoneMatch && ifNoneMatch === etag) {
      reply.status(304).send();
      return;
    }

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
