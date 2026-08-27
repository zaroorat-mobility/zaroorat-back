import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { container } from '@core/di';
import { errorEnvelope, isCodedError } from '@core/errors/envelope.js';
import { AdminPromotionsController } from './promotions.controller.js';

function handlePromotionsError(err: unknown, request: FastifyRequest, reply: FastifyReply): void {
  if (err instanceof ZodError) {
    reply.status(400).send(
      errorEnvelope('VALIDATION', 'Request validation failed', request.id, {
        details: err.issues,
      }),
    );
    return;
  }
  if (isCodedError(err) && err.statusCode < 500) {
    reply.status(err.statusCode).send(errorEnvelope(err.code, err.message, request.id));
    return;
  }
  request.log.error({ err }, '[admin-promotions] unhandled error');
  reply
    .status(500)
    .send(errorEnvelope('INTERNAL', 'An unexpected promotions admin error occurred', request.id));
}

export async function promotionsManagementRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.setErrorHandler(handlePromotionsError);

  const controller = container.resolve<AdminPromotionsController>('adminPromotionsController');
  const canRead = { preHandler: fastify.authorize({ permissions: ['campaigns:read'] }) };
  const canWrite = { preHandler: fastify.authorize({ permissions: ['campaigns:write'] }) };

  fastify.get('/cities', canRead, (req, reply) => controller.listCities(req, reply));

  // Reports (before :id routes)
  fastify.get('/promotions/reports/overview', canRead, (req, reply) =>
    controller.reportOverview(req, reply),
  );
  fastify.get('/promotions/:id/performance', canRead, (req, reply) =>
    controller.reportPerformance(req, reply),
  );

  // Promotions
  fastify.get('/promotions', canRead, (req, reply) => controller.listPromotions(req, reply));
  fastify.get('/promotions/:id', canRead, (req, reply) => controller.getPromotion(req, reply));
  fastify.post('/promotions', canWrite, (req, reply) => controller.createPromotion(req, reply));
  fastify.patch('/promotions/:id', canWrite, (req, reply) =>
    controller.updatePromotion(req, reply),
  );
  fastify.post('/promotions/:id/activate', canWrite, (req, reply) =>
    controller.activatePromotion(req, reply),
  );
  fastify.post('/promotions/:id/deactivate', canWrite, (req, reply) =>
    controller.deactivatePromotion(req, reply),
  );

  // Campaigns
  fastify.get('/campaigns', canRead, (req, reply) => controller.listCampaigns(req, reply));
  fastify.get('/campaigns/:id', canRead, (req, reply) => controller.getCampaign(req, reply));
  fastify.post('/campaigns', canWrite, (req, reply) => controller.createCampaign(req, reply));
  fastify.patch('/campaigns/:id', canWrite, (req, reply) => controller.updateCampaign(req, reply));
  fastify.put('/campaigns/:id/targets', canWrite, (req, reply) =>
    controller.setCampaignTargets(req, reply),
  );

  // Segments
  fastify.get('/segments', canRead, (req, reply) => controller.listSegments(req, reply));
  fastify.get('/segments/:id', canRead, (req, reply) => controller.getSegment(req, reply));
  fastify.post('/segments', canWrite, (req, reply) => controller.createSegment(req, reply));
  fastify.patch('/segments/:id', canWrite, (req, reply) => controller.updateSegment(req, reply));
  fastify.delete('/segments/:id', canWrite, (req, reply) => controller.removeSegment(req, reply));

  // Coupon batches & coupons
  fastify.get('/coupon-batches', canRead, (req, reply) => controller.listCouponBatches(req, reply));
  fastify.get('/coupon-batches/:id', canRead, (req, reply) =>
    controller.getCouponBatch(req, reply),
  );
  fastify.post('/coupon-batches', canWrite, (req, reply) =>
    controller.createCouponBatch(req, reply),
  );
  fastify.post('/coupon-batches/:id/generate', canWrite, (req, reply) =>
    controller.generateCoupons(req, reply),
  );
  fastify.post('/coupon-batches/:id/activate', canWrite, (req, reply) =>
    controller.activateCouponBatch(req, reply),
  );
  fastify.post('/coupon-batches/:id/deactivate', canWrite, (req, reply) =>
    controller.deactivateCouponBatch(req, reply),
  );
  fastify.get('/coupons', canRead, (req, reply) => controller.listCoupons(req, reply));

  // Banners
  fastify.get('/promo-banners', canRead, (req, reply) => controller.listBanners(req, reply));
  fastify.get('/promo-banners/:id', canRead, (req, reply) => controller.getBanner(req, reply));
  fastify.post('/promo-banners', canWrite, (req, reply) => controller.createBanner(req, reply));
  fastify.patch('/promo-banners/:id', canWrite, (req, reply) =>
    controller.updateBanner(req, reply),
  );
  fastify.post('/promo-banners/:id/activate', canWrite, (req, reply) =>
    controller.activateBanner(req, reply),
  );
  fastify.post('/promo-banners/:id/deactivate', canWrite, (req, reply) =>
    controller.deactivateBanner(req, reply),
  );
  fastify.delete('/promo-banners/:id', canWrite, (req, reply) =>
    controller.removeBanner(req, reply),
  );
}
