import type { FastifyReply, FastifyRequest } from 'fastify';
import { AdminPromotionService } from './promotion.service.js';
import { AdminCampaignService } from './campaign.service.js';
import { AdminSegmentService } from './segment.service.js';
import { AdminCouponService } from './coupon.service.js';
import { AdminBannerService } from './banner.service.js';
import { AdminPromoReportService } from './report.service.js';
import { AdminCityService } from './city.service.js';
import {
  createBannerBodySchema,
  createCampaignBodySchema,
  createCouponBatchBodySchema,
  createPromotionBodySchema,
  createSegmentBodySchema,
  generateCouponsBodySchema,
  idParamSchema,
  listBannersQuerySchema,
  listCampaignsQuerySchema,
  listCouponBatchesQuerySchema,
  listCouponsQuerySchema,
  listPromotionsQuerySchema,
  listSegmentsQuerySchema,
  reportOverviewQuerySchema,
  setCampaignTargetsBodySchema,
  updateBannerBodySchema,
  updateCampaignBodySchema,
  updatePromotionBodySchema,
  updateSegmentBodySchema,
} from './schemas.js';

export class AdminPromotionsController {
  constructor(
    private readonly adminPromotionService: AdminPromotionService,
    private readonly adminCampaignService: AdminCampaignService,
    private readonly adminSegmentService: AdminSegmentService,
    private readonly adminCouponService: AdminCouponService,
    private readonly adminBannerService: AdminBannerService,
    private readonly adminPromoReportService: AdminPromoReportService,
    private readonly adminCityService: AdminCityService,
  ) {}

  async listCities(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
    reply.send(await this.adminCityService.listActive());
  }

  // Promotions
  async listPromotions(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = listPromotionsQuerySchema.parse(req.query);
    reply.send(await this.adminPromotionService.list(query));
  }

  async getPromotion(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = idParamSchema.parse(req.params);
    reply.send({ data: await this.adminPromotionService.getById(id) });
  }

  async createPromotion(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const body = createPromotionBodySchema.parse(req.body);
    reply.status(201).send({ data: await this.adminPromotionService.create(body) });
  }

  async updatePromotion(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = idParamSchema.parse(req.params);
    const body = updatePromotionBodySchema.parse(req.body ?? {});
    reply.send({ data: await this.adminPromotionService.update(id, body) });
  }

  async activatePromotion(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = idParamSchema.parse(req.params);
    reply.send({ data: await this.adminPromotionService.activate(id) });
  }

  async deactivatePromotion(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = idParamSchema.parse(req.params);
    reply.send({ data: await this.adminPromotionService.deactivate(id) });
  }

  // Campaigns
  async listCampaigns(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = listCampaignsQuerySchema.parse(req.query);
    reply.send(await this.adminCampaignService.list(query));
  }

  async getCampaign(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = idParamSchema.parse(req.params);
    reply.send({ data: await this.adminCampaignService.getById(id) });
  }

  async createCampaign(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const body = createCampaignBodySchema.parse(req.body);
    const userId = req.auth?.userId;
    reply.status(201).send({ data: await this.adminCampaignService.create(body, userId) });
  }

  async updateCampaign(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = idParamSchema.parse(req.params);
    const body = updateCampaignBodySchema.parse(req.body ?? {});
    reply.send({ data: await this.adminCampaignService.update(id, body) });
  }

  async setCampaignTargets(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = idParamSchema.parse(req.params);
    const body = setCampaignTargetsBodySchema.parse(req.body);
    reply.send({ data: await this.adminCampaignService.setTargets(id, body) });
  }

  // Segments
  async listSegments(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = listSegmentsQuerySchema.parse(req.query);
    reply.send(await this.adminSegmentService.list(query));
  }

  async getSegment(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = idParamSchema.parse(req.params);
    reply.send({ data: await this.adminSegmentService.getById(id) });
  }

  async createSegment(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const body = createSegmentBodySchema.parse(req.body);
    reply.status(201).send({ data: await this.adminSegmentService.create(body) });
  }

  async updateSegment(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = idParamSchema.parse(req.params);
    const body = updateSegmentBodySchema.parse(req.body ?? {});
    reply.send({ data: await this.adminSegmentService.update(id, body) });
  }

  async removeSegment(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = idParamSchema.parse(req.params);
    await this.adminSegmentService.remove(id);
    reply.send({ success: true });
  }

  // Coupon batches / coupons
  async listCouponBatches(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = listCouponBatchesQuerySchema.parse(req.query);
    reply.send(await this.adminCouponService.listBatches(query));
  }

  async getCouponBatch(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = idParamSchema.parse(req.params);
    reply.send({ data: await this.adminCouponService.getBatch(id) });
  }

  async createCouponBatch(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const body = createCouponBatchBodySchema.parse(req.body);
    reply.status(201).send({ data: await this.adminCouponService.createBatch(body) });
  }

  async generateCoupons(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = idParamSchema.parse(req.params);
    const body = generateCouponsBodySchema.parse(req.body);
    reply.send({ data: await this.adminCouponService.generateCoupons(id, body) });
  }

  async activateCouponBatch(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = idParamSchema.parse(req.params);
    reply.send({ data: await this.adminCouponService.activateBatch(id) });
  }

  async deactivateCouponBatch(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = idParamSchema.parse(req.params);
    reply.send({ data: await this.adminCouponService.deactivateBatch(id) });
  }

  async listCoupons(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = listCouponsQuerySchema.parse(req.query);
    reply.send(await this.adminCouponService.listCoupons(query));
  }

  // Banners
  async listBanners(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = listBannersQuerySchema.parse(req.query);
    reply.send(await this.adminBannerService.list(query));
  }

  async getBanner(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = idParamSchema.parse(req.params);
    reply.send({ data: await this.adminBannerService.getById(id) });
  }

  async createBanner(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const body = createBannerBodySchema.parse(req.body);
    reply.status(201).send({ data: await this.adminBannerService.create(body) });
  }

  async updateBanner(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = idParamSchema.parse(req.params);
    const body = updateBannerBodySchema.parse(req.body ?? {});
    reply.send({ data: await this.adminBannerService.update(id, body) });
  }

  async activateBanner(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = idParamSchema.parse(req.params);
    reply.send({ data: await this.adminBannerService.activate(id) });
  }

  async deactivateBanner(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = idParamSchema.parse(req.params);
    reply.send({ data: await this.adminBannerService.deactivate(id) });
  }

  async removeBanner(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = idParamSchema.parse(req.params);
    await this.adminBannerService.remove(id);
    reply.send({ success: true });
  }

  // Reports
  async reportOverview(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = reportOverviewQuerySchema.parse(req.query);
    reply.send({ data: await this.adminPromoReportService.overview(query) });
  }

  async reportPerformance(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = idParamSchema.parse(req.params);
    const query = reportOverviewQuerySchema.parse(req.query);
    reply.send({ data: await this.adminPromoReportService.performance(id, query) });
  }
}
