import type { FastifyInstance } from 'fastify';
import { asClass, AwilixContainer } from 'awilix';
import { registerFileReference } from '@modules/files';

import {
  pricingManagementRoutes,
  AdminSurgeController,
  AdminSurgeService,
  AdminFareController,
  AdminFareService,
  AdminCancellationController,
  AdminCancellationService,
  AdminServiceZoneController,
  AdminServiceZoneService,
  AdminInvoiceController,
  AdminInvoiceService,
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
  AdminFinanceController,
  AdminFinanceService,
  DocumentComplianceController,
  DocumentComplianceService,
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
import {
  geographicManagementRoutes,
  AdminGeographicController,
  AdminGeographicService,
} from './geographic-management/index.js';
import {
  operationsManagementRoutes,
  AdminRideController,
  AdminRideService,
  AdminLiveController,
  AdminLiveService,
  AdminDispatchController,
  AdminDispatchService,
  AdminTicketController,
  AdminTicketService,
  AdminSafetyController,
  AdminSafetyService,
} from './operations-management/index.js';
import { AdminDashboardController, AdminDashboardService } from './dashboard/index.js';
import {
  communicationsManagementRoutes,
  AdminCommunicationsController,
  AdminCommunicationsTemplateService,
  AdminCommunicationsHistoryService,
  AdminCommunicationsPushService,
} from './communications-management/index.js';
import {
  AdminMonitoringController,
  AdminMonitoringService,
  monitoringManagementRoutes,
} from './monitoring-management/index.js';
import {
  AdminSecurityController,
  AdminSecurityService,
  securityManagementRoutes,
} from './security-management/index.js';
import {
  AdminAuditController,
  AdminAuditService,
  auditManagementRoutes,
} from './audit-management/index.js';
import {
  AdminJobsController,
  AdminJobsService,
  jobsManagementRoutes,
} from './jobs-management/index.js';

import {
  systemSettingsRoutes,
  SystemSettingRepository,
  SystemSettingService,
  SystemSettingsCache,
  MapProviderHealthService,
  AdminMapSettingsService,
  AdminMapSettingsController,
  PlatformConfigResolver,
  FeatureFlagService,
  AdminPlatformSettingsService,
  AdminPlatformSettingsController,
  IntegrationHealthService,
  AdminPaymentSettingsService,
  AdminSmsSettingsService,
  AdminPushSettingsService,
  AdminEmailSettingsService,
  AdminIntegrationSettingsController,
} from './system-settings/index.js';

export function registerAdminModule(container: AwilixContainer): void {
  container.register({
    systemSettingRepository: asClass(SystemSettingRepository).singleton(),
    systemSettingService: asClass(SystemSettingService).singleton(),
    systemSettingsCache: asClass(SystemSettingsCache).singleton(),
    mapProviderHealthService: asClass(MapProviderHealthService).singleton(),
    adminMapSettingsService: asClass(AdminMapSettingsService).singleton(),
    adminMapSettingsController: asClass(AdminMapSettingsController).singleton(),
    platformConfigResolver: asClass(PlatformConfigResolver).singleton(),
    featureFlagService: asClass(FeatureFlagService).singleton(),
    adminPlatformSettingsService: asClass(AdminPlatformSettingsService).singleton(),
    adminPlatformSettingsController: asClass(AdminPlatformSettingsController).singleton(),
    integrationHealthService: asClass(IntegrationHealthService).singleton(),
    adminPaymentSettingsService: asClass(AdminPaymentSettingsService).singleton(),
    adminSmsSettingsService: asClass(AdminSmsSettingsService).singleton(),
    adminPushSettingsService: asClass(AdminPushSettingsService).singleton(),
    adminEmailSettingsService: asClass(AdminEmailSettingsService).singleton(),
    adminIntegrationSettingsController: asClass(AdminIntegrationSettingsController).singleton(),
    adminSurgeService: asClass(AdminSurgeService).singleton(),
    adminSurgeController: asClass(AdminSurgeController).singleton(),
    adminFareService: asClass(AdminFareService).singleton(),
    adminFareController: asClass(AdminFareController).singleton(),
    adminServiceZoneService: asClass(AdminServiceZoneService).singleton(),
    adminServiceZoneController: asClass(AdminServiceZoneController).singleton(),
    adminCancellationService: asClass(AdminCancellationService).singleton(),
    adminCancellationController: asClass(AdminCancellationController).singleton(),
    adminInvoiceService: asClass(AdminInvoiceService).singleton(),
    adminInvoiceController: asClass(AdminInvoiceController).singleton(),
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
    adminFinanceService: asClass(AdminFinanceService).singleton(),
    adminFinanceController: asClass(AdminFinanceController).singleton(),
    documentComplianceService: asClass(DocumentComplianceService).singleton(),
    documentComplianceController: asClass(DocumentComplianceController).singleton(),
    adminStaffService: asClass(AdminStaffService).singleton(),
    adminStaffController: asClass(AdminStaffController).singleton(),
    adminRbacService: asClass(AdminRbacService).singleton(),
    adminRbacController: asClass(AdminRbacController).singleton(),
    adminRiderService: asClass(AdminRiderService).singleton(),
    adminRiderController: asClass(AdminRiderController).singleton(),
    adminGeographicService: asClass(AdminGeographicService).singleton(),
    adminGeographicController: asClass(AdminGeographicController).singleton(),
    adminRideService: asClass(AdminRideService).singleton(),
    adminRideController: asClass(AdminRideController).singleton(),
    adminLiveService: asClass(AdminLiveService).singleton(),
    adminLiveController: asClass(AdminLiveController).singleton(),
    adminDispatchService: asClass(AdminDispatchService).singleton(),
    adminDispatchController: asClass(AdminDispatchController).singleton(),
    adminTicketService: asClass(AdminTicketService).singleton(),
    adminTicketController: asClass(AdminTicketController).singleton(),
    adminSafetyService: asClass(AdminSafetyService).singleton(),
    adminSafetyController: asClass(AdminSafetyController).singleton(),
    adminDashboardService: asClass(AdminDashboardService).singleton(),
    adminDashboardController: asClass(AdminDashboardController).singleton(),
    adminMonitoringService: asClass(AdminMonitoringService).singleton(),
    adminMonitoringController: asClass(AdminMonitoringController).singleton(),
    adminSecurityService: asClass(AdminSecurityService).singleton(),
    adminSecurityController: asClass(AdminSecurityController).singleton(),
    adminAuditService: asClass(AdminAuditService).singleton(),
    adminAuditController: asClass(AdminAuditController).singleton(),
    adminJobsService: asClass(AdminJobsService).singleton(),
    adminJobsController: asClass(AdminJobsController).singleton(),
    adminCommunicationsTemplateService: asClass(AdminCommunicationsTemplateService).singleton(),
    adminCommunicationsHistoryService: asClass(AdminCommunicationsHistoryService).singleton(),
    adminCommunicationsPushService: asClass(AdminCommunicationsPushService).singleton(),
    adminCommunicationsController: asClass(AdminCommunicationsController).singleton(),
  });

  registerFileReference('PROMO_BANNER', {
    module: 'promotions',
    isReferenced: (fileId, tx) =>
      container.resolve<AdminBannerService>('adminBannerService').isBannerImage(fileId, tx),
  });
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  await app.register(systemSettingsRoutes);
  await app.register(pricingManagementRoutes);
  await app.register(promotionsManagementRoutes);
  await app.register(referralManagementRoutes);
  await app.register(driverManagementRoutes);
  await app.register(vehicleManagementRoutes);
  await app.register(paymentManagementRoutes);
  await app.register(staffManagementRoutes);
  await app.register(rbacManagementRoutes);
  await app.register(riderManagementRoutes);
  await app.register(geographicManagementRoutes, { prefix: '/geographic' });
  await app.register(operationsManagementRoutes, { prefix: '/operations' });
  await app.register(monitoringManagementRoutes, { prefix: '/monitoring' });
  await app.register(securityManagementRoutes, { prefix: '/security' });
  await app.register(auditManagementRoutes, { prefix: '/audit' });
  await app.register(jobsManagementRoutes, { prefix: '/jobs' });
  await app.register(communicationsManagementRoutes, { prefix: '/communications' });
}
