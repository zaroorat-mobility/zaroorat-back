import type { FastifyInstance } from 'fastify';
import { container } from '@core/di';
import { PromotionController } from '../controllers/promotion.controller.js';

export async function promotionRoutes(fastify: FastifyInstance): Promise<void> {
  const controller = container.resolve<PromotionController>('promotionController');

  fastify.get('/home', { config: { public: true } }, controller.getHomeBanners);
  fastify.get('/available', controller.getAvailablePromotions);
}
