import type { FastifyInstance } from 'fastify';
import { asClass, AwilixContainer } from 'awilix';

import {
  pricingManagementRoutes,
  AdminSurgeController,
  AdminSurgeService,
  AdminFareController,
  AdminFareService,
  AdminCancellationController,
  AdminCancellationService,
} from './pricing-management/index.js';
import {
  promotionsManagementRoutes,
  AdminPromotionsController,
  AdminPromotionService,
  AdminCampaignService,
  AdminSegmentService,
  AdminCouponService,
  AdminBannerService,
  AdminPromoReportService,
  AdminCityService,
} from './promotions-management/index.js';
import {
  referralManagementRoutes,
  AdminReferralController,
  AdminReferralProgramService,
  AdminReferralCodeService,
  AdminReferralHistoryService,
} from './referral-management/index.js';
import {
  driverManagementRoutes,
  AdminDriverManagementController,
  AdminDriverService,
  AdminApplicationService,
} from './driver-management/index.js';
import {
  vehicleManagementRoutes,
  AdminVehicleManagementController,
  AdminVehicleService,
} from './vehicle-management/index.js';
import {
  paymentManagementRoutes,
  AdminPaymentManagementController,
} from './payment-management/index.js';
import {
  staffManagementRoutes,
  AdminStaffController,
  AdminStaffService,
} from './staff-management/index.js';
import {
  rbacManagementRoutes,
  AdminRbacController,
  AdminRbacService,
} from './rbac-management/index.js';
import {
  riderManagementRoutes,
  AdminRiderController,
  AdminRiderService,
} from './rider-management/index.js';

export function registerAdminModule(container: AwilixContainer): void {
  container.register({
    adminSurgeService: asClass(AdminSurgeService).singleton(),
    adminSurgeController: asClass(AdminSurgeController).singleton(),
    adminFareService: asClass(AdminFareService).singleton(),
    adminFareController: asClass(AdminFareController).singleton(),
    adminCancellationService: asClass(AdminCancellationService).singleton(),
    adminCancellationController: asClass(AdminCancellationController).singleton(),
    adminPromotionService: asClass(AdminPromotionService).singleton(),
    adminCampaignService: asClass(AdminCampaignService).singleton(),
    adminSegmentService: asClass(AdminSegmentService).singleton(),
    adminCouponService: asClass(AdminCouponService).singleton(),
    adminBannerService: asClass(AdminBannerService).singleton(),
    adminPromoReportService: asClass(AdminPromoReportService).singleton(),
    adminCityService: asClass(AdminCityService).singleton(),
    adminPromotionsController: asClass(AdminPromotionsController).singleton(),
    adminReferralProgramService: asClass(AdminReferralProgramService).singleton(),
    adminReferralCodeService: asClass(AdminReferralCodeService).singleton(),
    adminReferralHistoryService: asClass(AdminReferralHistoryService).singleton(),
    adminReferralController: asClass(AdminReferralController).singleton(),
    adminDriverService: asClass(AdminDriverService).singleton(),
    adminApplicationService: asClass(AdminApplicationService).singleton(),
    adminDriverManagementController: asClass(AdminDriverManagementController).singleton(),
    adminVehicleService: asClass(AdminVehicleService).singleton(),
    adminVehicleManagementController: asClass(AdminVehicleManagementController).singleton(),
    adminPaymentManagementController: asClass(AdminPaymentManagementController).singleton(),
    adminStaffService: asClass(AdminStaffService).singleton(),
    adminStaffController: asClass(AdminStaffController).singleton(),
    adminRbacService: asClass(AdminRbacService).singleton(),
    adminRbacController: asClass(AdminRbacController).singleton(),
    adminRiderService: asClass(AdminRiderService).singleton(),
    adminRiderController: asClass(AdminRiderController).singleton(),
  });
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  await app.register(pricingManagementRoutes);
  await app.register(promotionsManagementRoutes);
  await app.register(referralManagementRoutes);
  await app.register(driverManagementRoutes);
  await app.register(vehicleManagementRoutes);
  await app.register(paymentManagementRoutes);
  await app.register(staffManagementRoutes);
  await app.register(rbacManagementRoutes);
  await app.register(riderManagementRoutes);
}
