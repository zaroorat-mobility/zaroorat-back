import type { FastifyReply, FastifyRequest } from 'fastify';
import { callerId } from '@core/auth';
import { PromotionService } from '../promotion.service.js';
import { listAvailablePromotionsQuerySchema } from '../schemas/promotion.schemas.js';

export class PromotionController {
  constructor(private readonly promotionService: PromotionService) {}

  getHomeBanners = async (_req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const banners = await this.promotionService.listHomeBanners();
    return reply.send({ data: banners });
  };

  getAvailablePromotions = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const userId = callerId(req);
    const parsed = listAvailablePromotionsQuerySchema.parse(req.query ?? {});
    const promotions = await this.promotionService.listAvailablePromotions(userId, parsed);
    return reply.send({ data: promotions });
  };
}
